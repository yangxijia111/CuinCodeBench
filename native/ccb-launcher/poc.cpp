// ccb-launcher PoC（v1.3 P1）：验证 Job Object 核心 API 序列与资源限制语义。
// 目的：在进入正式帧协议实现（launcher.cpp）之前，用最小代码证明：
//   1. CreateProcessW(CREATE_SUSPENDED) → AssignProcessToJobObject → ResumeThread
//      的顺序可落地（进程首条指令执行前已在 Job 内）；
//   2. KILL_ON_JOB_CLOSE：launcher 被强杀时整树自动终止；
//   3. JOB_OBJECT_LIMIT_ACTIVE_PROCESSES 截断 fork 炸弹；
//   4. JOB_OBJECT_LIMIT_PROCESS_MEMORY / JOB_MEMORY 触发可观测（记账峰值 ≥ 限制）；
//   5. 超时 → TerminateJobObject 整树终止；
//   6. 子/孙进程均被 Job 覆盖（containment 无逃逸）。
// 正式版（帧协议、IO 转发、双层限制、错误矩阵）见 docs/V1_3_JOB_OBJECT_DESIGN.md。
//
// PoC 约定（仅测试使用，不进产品路径）：
//   ccb-launcher-poc.exe run
//     --result <file>        结束时写入 JSON 结果（纯数字/布尔，无转义需求）
//     --childpid <file>      CreateProcess 成功后立即写入子进程 PID
//     [--memory <bytes>]     PROCESS_MEMORY + JOB_MEMORY 上限
//     [--processes <n>]      ACTIVE_PROCESS_LIMIT
//     [--timeout <ms>]       等待超时（默认 10000，超时 TerminateJobObject）
//     -- <program> [args...]
//   子进程 stdio 直接继承 launcher（PoC 不做 IO 转发）。

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h> // CommandLineToArgvW

#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

// UTF-8 ↔ UTF-16（参数与环境均按宽字符处理，路径/参数支持 Unicode）
static std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return std::wstring();
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring out(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), out.data(), n);
  return out;
}

static std::string WideToUtf8(const std::wstring& w) {
  if (w.empty()) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string out(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), out.data(), n, nullptr, nullptr);
  return out;
}

// 标准 MSVCRT argv quoting 规则（Raymond Chen 算法）：
// 空参数 → ""；无空白/引号 → 原样；否则加引号 + 反斜杠仅在引号前翻倍
static std::wstring QuoteArg(const std::wstring& arg) {
  if (arg.empty()) return L"\"\"";
  bool needQuotes = false;
  for (wchar_t c : arg) {
    if (c == L' ' || c == L'\t' || c == L'"') { needQuotes = true; break; }
  }
  if (!needQuotes) return arg;
  std::wstring out;
  out.push_back(L'"');
  size_t backslashes = 0;
  for (wchar_t c : arg) {
    if (c == L'\\') {
      backslashes++;
      continue;
    }
    if (c == L'"') {
      // 引号前的反斜杠翻倍，再加转义引号
      out.append(backslashes * 2 + 1, L'\\');
      out.push_back(L'"');
    } else {
      out.append(backslashes, L'\\');
      out.push_back(c);
    }
    backslashes = 0;
  }
  // 闭合引号前：尾部反斜杠翻倍
  out.append(backslashes * 2, L'\\');
  out.push_back(L'"');
  return out;
}

static bool WriteFileUtf8(const std::wstring& path, const std::string& content) {
  HANDLE h = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                         CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  DWORD written = 0;
  BOOL ok = WriteFile(h, content.data(), (DWORD)content.size(), &written, nullptr);
  CloseHandle(h);
  return ok != FALSE;
}

static bool WritePidFile(const std::wstring& path, DWORD pid) {
  char buf[32];
  int n = _snprintf_s(buf, sizeof(buf), _TRUNCATE, "%lu", (unsigned long)pid);
  return WriteFileUtf8(path, std::string(buf, (size_t)n));
}

// 失败即写错误结果并退出（exit code 4 = 内部失败；0 = 正常完成含子进程非零退出）
static void Fail(const std::wstring& resultPath, const char* stage, DWORD lastError) {
  if (!resultPath.empty()) {
    char buf[256];
    _snprintf_s(buf, sizeof(buf), _TRUNCATE,
                "{\"ok\":false,\"stage\":\"%s\",\"win32LastError\":%lu}",
                stage, (unsigned long)lastError);
    WriteFileUtf8(resultPath, buf);
  }
  ExitProcess(4);
}

static DWORDLONG QueryJobPeakMemory(HANDLE job, SIZE_T* peakProc, SIZE_T* peakJob) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION ext{};
  if (!QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &ext,
                                 sizeof(ext), nullptr)) {
    return 0;
  }
  if (peakProc) *peakProc = ext.PeakProcessMemoryUsed;
  if (peakJob) *peakJob = ext.PeakJobMemoryUsed;
  return 0;
}

int wmain(int argc, wchar_t** argv) {
  std::wstring resultPath, childPidPath, program;
  std::vector<std::wstring> args;
  DWORDLONG memoryLimit = 0;
  DWORD processLimit = 0;
  DWORD timeoutMs = 10000;

  // —— 参数解析（长选项风格，-- 之后的第一个非选项为 program）——
  int i = 1;
  // 第一个参数必须是子命令 run（为正式版子命令扩展留形态）
  if (argc < 2 || std::wstring(argv[1]) != L"run") {
    fwprintf(stderr, L"usage: ccb-launcher-poc.exe run [options] -- <program> [args...]\n");
    return 2;
  }
  i = 2;
  bool pastSeparator = false;
  for (; i < argc; i++) {
    std::wstring a = argv[i];
    if (!pastSeparator && a == L"--") { pastSeparator = true; continue; }
    if (!pastSeparator && a.rfind(L"--", 0) == 0) {
      auto value = [&]() -> std::wstring {
        if (i + 1 >= argc) Fail(L"", "arg_missing_value", 87);
        return argv[++i];
      };
      if (a == L"--result") resultPath = value();
      else if (a == L"--childpid") childPidPath = value();
      else if (a == L"--memory") memoryLimit = (DWORDLONG)_wcstoui64(value().c_str(), nullptr, 10);
      else if (a == L"--processes") processLimit = (DWORD)wcstoul(value().c_str(), nullptr, 10);
      else if (a == L"--timeout") timeoutMs = (DWORD)wcstoul(value().c_str(), nullptr, 10);
      else Fail(L"", "unknown_option", 87);
      continue;
    }
    if (program.empty()) program = a;
    else args.push_back(a);
  }
  if (program.empty()) Fail(resultPath, "no_program", 87);

  // —— Job 创建与限制（正式版同序）——
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job == nullptr) Fail(resultPath, "create_job_failed", GetLastError());

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION ext{};
  ext.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  if (processLimit > 0) {
    ext.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    ext.BasicLimitInformation.ActiveProcessLimit = processLimit;
  }
  if (memoryLimit > 0) {
    ext.BasicLimitInformation.LimitFlags |=
        JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY;
    ext.ProcessMemoryLimit = memoryLimit;
    ext.JobMemoryLimit = memoryLimit;
  }
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &ext, sizeof(ext))) {
    Fail(resultPath, "set_job_limits_failed", GetLastError());
  }

  // —— 命令行构造：quote(program) + args ——
  std::wstring cmdline = QuoteArg(program);
  for (const auto& a : args) {
    cmdline += L" ";
    cmdline += QuoteArg(a);
  }

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};
  // CREATE_SUSPENDED：主线程挂起——Assign 完成前子进程不可能执行任何指令
  if (!CreateProcessW(program.c_str(), cmdline.data(), nullptr, nullptr, FALSE,
                      CREATE_SUSPENDED, nullptr, nullptr, &si, &pi)) {
    Fail(resultPath, "create_process_failed", GetLastError());
  }

  // 核心：ResumeThread 之前 Assign（PoC 1 号验证点，顺序即正确性）
  if (!AssignProcessToJobObject(job, pi.hProcess)) {
    TerminateProcess(pi.hProcess, 1);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    Fail(resultPath, "assign_job_failed", GetLastError());
  }
  if (ResumeThread(pi.hThread) == (DWORD)-1) {
    TerminateProcess(pi.hProcess, 1);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    Fail(resultPath, "resume_thread_failed", GetLastError());
  }
  CloseHandle(pi.hThread);

  if (!childPidPath.empty()) WritePidFile(childPidPath, pi.dwProcessId);

  // —— 等待与超时整树终止 ——
  bool timedOut = false;
  DWORD wait = WaitForSingleObject(pi.hProcess, timeoutMs);
  if (wait == WAIT_FAILED) {
    Fail(resultPath, "wait_failed", GetLastError());
  } else if (wait == WAIT_TIMEOUT) {
    timedOut = true;
    // TerminateJobObject：一次调用终止 Job 内全部进程（无枚举竞态）
    TerminateJobObject(job, 1);
    WaitForSingleObject(pi.hProcess, 5000);
  }

  DWORD exitCode = 0;
  if (!GetExitCodeProcess(pi.hProcess, &exitCode)) {
    Fail(resultPath, "get_exit_code_failed", GetLastError());
  }

  SIZE_T peakProcMem = 0, peakJobMem = 0;
  QueryJobPeakMemory(job, &peakProcMem, &peakJobMem);

  CloseHandle(pi.hProcess);
  CloseHandle(job); // 正常收尾：树已退出，KILL_ON_JOB_CLOSE 无残留

  // —— 结果（纯数字/布尔 JSON）——
  char buf[512];
  _snprintf_s(buf, sizeof(buf), _TRUNCATE,
              "{\"ok\":true,\"exitCode\":%lu,\"timedOut\":%s,"
              "\"peakProcessMemoryBytes\":%llu,\"peakJobMemoryBytes\":%llu}",
              (unsigned long)exitCode, timedOut ? "true" : "false",
              (unsigned long long)peakProcMem, (unsigned long long)peakJobMem);
  if (!resultPath.empty()) WriteFileUtf8(resultPath, buf);
  return 0;
}
