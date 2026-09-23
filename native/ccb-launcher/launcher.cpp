// ccb-launcher 正式版（v1.3 P2）：Windows Job Object 资源围栏 launcher。
// 设计文档：docs/V1_3_JOB_OBJECT_DESIGN.md（协议、生命周期、限制语义、错误矩阵）。
//
// 定位声明：资源围栏（containment），不是安全沙箱；不可信恶意代码仍不可安全运行。
//
// 协议（stdio 管道，帧 = [u8 type][u32 LE len][payload]）：
//   N→L  0x01 REQ（首帧，UTF-8 JSON，version=1）
//   N→L  0x02 STDIN（原始字节 ≤256KB/帧）
//   N→L  0x03 STDIN_EOF（空）
//   L→N  0x10 STDOUT / 0x11 STDERR（原始字节 ≤256KB/帧）
//   L→N  0x20 INFO（JSON，Resume 后一次：childPid）
//   L→N  0x21 RESULT（JSON，终帧）
//   L→N  0x22 ERROR（JSON，致命错误，终帧）
// 退出码：0 正常；2 协议损坏；3 版本不支持；4 致命错误（ERROR 帧已发）。
//
// 线程模型：main（编排 + 等待）+ stdin 转发 + stdout 读 + stderr 读 + Job 记账轮询。
// 限制：KILL_ON_JOB_CLOSE + ACTIVE_PROCESS_LIMIT + PROCESS/JOB_MEMORY；
//       超时 → TerminateJobObject；输出上限（launcher 层）→ TerminateJobObject。
// 句柄安全：PROC_THREAD_ATTRIBUTE_HANDLE_LIST 白名单 = 子进程三个 stdio 句柄。

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <functional>
#include <map>
#include <string>
#include <thread>
#include <utility>
#include <vector>

// ============================================================
// 协议常量（与 src/main/runner/native-protocol.ts 双端同值）
// ============================================================
static const uint8_t FRAME_REQ = 0x01;
static const uint8_t FRAME_STDIN = 0x02;
static const uint8_t FRAME_STDIN_EOF = 0x03;
static const uint8_t FRAME_STDOUT = 0x10;
static const uint8_t FRAME_STDERR = 0x11;
static const uint8_t FRAME_INFO = 0x20;
static const uint8_t FRAME_RESULT = 0x21;
static const uint8_t FRAME_ERROR = 0x22;

static const uint32_t MAX_DATA_PAYLOAD = 256 * 1024;
static const uint32_t MAX_JSON_PAYLOAD = 16 * 1024;
static const int PROTOCOL_VERSION = 1;

static const DWORD EXIT_OK = 0;
static const DWORD EXIT_PROTOCOL = 2;
static const DWORD EXIT_VERSION = 3;
static const DWORD EXIT_FATAL = 4;

// ============================================================
// UTF-8 ↔ UTF-16
// ============================================================
static std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return std::wstring();
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  if (n <= 0) return std::wstring();
  std::wstring out((size_t)n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &out[0], n);
  return out;
}

static std::string WideToUtf8(const std::wstring& w) {
  if (w.empty()) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  if (n <= 0) return std::string();
  std::string out((size_t)n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), &out[0], n, nullptr, nullptr);
  return out;
}

// ============================================================
// 极简 JSON：解析（REQ）与构建（INFO/RESULT/ERROR）
// ============================================================
struct JsonValue {
  enum Type { Null, Bool, Num, Str, Arr, Obj } type = Null;
  bool b = false;
  double num = 0;
  std::wstring str;
  std::vector<JsonValue> arr;
  std::map<std::wstring, JsonValue> obj;

  const JsonValue* find(const wchar_t* key) const {
    auto it = obj.find(key);
    return it == obj.end() ? nullptr : &it->second;
  }
};

class JsonParser {
 public:
  static bool Parse(const std::string& utf8, JsonValue& out) {
    // 关键：先做 UTF-8 → UTF-16 真转换。直接 assign(bytes) 会把每个字节当成
    // 一个独立宽字符（Latin-1 式），破坏全部非 ASCII 参数/路径/环境值。
    s_ = Utf8ToWide(utf8);
    pos_ = 0;
    SkipWs();
    if (!ParseValue(out)) return false;
    SkipWs();
    return pos_ == s_.size();
  }

 private:
  static std::wstring s_;
  static size_t pos_;

  static void SkipWs() {
    while (pos_ < s_.size() && (s_[pos_] == L' ' || s_[pos_] == L'\t' || s_[pos_] == L'\n' ||
                                s_[pos_] == L'\r')) {
      pos_++;
    }
  }
  static bool Consume(wchar_t c) {
    if (pos_ < s_.size() && s_[pos_] == c) {
      pos_++;
      return true;
    }
    return false;
  }
  static bool ParseValue(JsonValue& v) {
    if (pos_ >= s_.size()) return false;
    wchar_t c = s_[pos_];
    if (c == L'{') return ParseObj(v);
    if (c == L'[') return ParseArr(v);
    if (c == L'"') {
      v.type = JsonValue::Str;
      return ParseStr(v.str);
    }
    if (c == L't' && s_.compare(pos_, 4, L"true") == 0) {
      pos_ += 4;
      v.type = JsonValue::Bool;
      v.b = true;
      return true;
    }
    if (c == L'f' && s_.compare(pos_, 5, L"false") == 0) {
      pos_ += 5;
      v.type = JsonValue::Bool;
      v.b = false;
      return true;
    }
    if (c == L'n' && s_.compare(pos_, 4, L"null") == 0) {
      pos_ += 4;
      v.type = JsonValue::Null;
      return true;
    }
    return ParseNum(v);
  }
  static bool ParseObj(JsonValue& v) {
    v.type = JsonValue::Obj;
    pos_++;
    SkipWs();
    if (Consume(L'}')) return true;
    for (;;) {
      SkipWs();
      JsonValue key;
      if (pos_ >= s_.size() || s_[pos_] != L'"') return false;
      if (!ParseStr(key.str)) return false;
      SkipWs();
      if (!Consume(L':')) return false;
      SkipWs();
      JsonValue val;
      if (!ParseValue(val)) return false;
      v.obj[key.str] = std::move(val);
      SkipWs();
      if (Consume(L',')) continue;
      if (Consume(L'}')) return true;
      return false;
    }
  }
  static bool ParseArr(JsonValue& v) {
    v.type = JsonValue::Arr;
    pos_++;
    SkipWs();
    if (Consume(L']')) return true;
    for (;;) {
      SkipWs();
      JsonValue item;
      if (!ParseValue(item)) return false;
      v.arr.push_back(std::move(item));
      SkipWs();
      if (Consume(L',')) continue;
      if (Consume(L']')) return true;
      return false;
    }
  }
  static bool ParseHex4(uint32_t& h) {
    h = 0;
    for (int i = 0; i < 4; i++) {
      if (pos_ >= s_.size()) return false;
      wchar_t c = s_[pos_++];
      h <<= 4;
      if (c >= L'0' && c <= L'9') h |= (uint32_t)(c - L'0');
      else if (c >= L'a' && c <= L'f') h |= (uint32_t)(c - L'a' + 10);
      else if (c >= L'A' && c <= L'F') h |= (uint32_t)(c - L'A' + 10);
      else return false;
    }
    return true;
  }
  static bool ParseStr(std::wstring& out) {
    pos_++;  // 开引号
    out.clear();
    for (;;) {
      if (pos_ >= s_.size()) return false;
      wchar_t c = s_[pos_++];
      if (c == L'"') return true;
      if (c != L'\\') {
        out.push_back(c);
        continue;
      }
      if (pos_ >= s_.size()) return false;
      wchar_t e = s_[pos_++];
      switch (e) {
        case L'"': out.push_back(L'"'); break;
        case L'\\': out.push_back(L'\\'); break;
        case L'/': out.push_back(L'/'); break;
        case L'b': out.push_back(L'\b'); break;
        case L'f': out.push_back(L'\f'); break;
        case L'n': out.push_back(L'\n'); break;
        case L'r': out.push_back(L'\r'); break;
        case L't': out.push_back(L'\t'); break;
        case L'u': {
          uint32_t h;
          if (!ParseHex4(h)) return false;
          if (h >= 0xD800 && h <= 0xDBFF && pos_ + 1 < s_.size() && s_[pos_] == L'\\' &&
              s_[pos_ + 1] == L'u') {
            pos_ += 2;
            uint32_t lo;
            if (!ParseHex4(lo)) return false;
            if (lo < 0xDC00 || lo > 0xDFFF) return false;
            h = 0x10000 + ((h - 0xD800) << 10) + (lo - 0xDC00);
          }
          out.push_back((wchar_t)h);
          break;
        }
        default:
          return false;
      }
    }
  }
  static bool ParseNum(JsonValue& v) {
    size_t start = pos_;
    if (pos_ < s_.size() && (s_[pos_] == L'-' || s_[pos_] == L'+')) pos_++;
    bool digits = false;
    while (pos_ < s_.size() && ((s_[pos_] >= L'0' && s_[pos_] <= L'9') || s_[pos_] == L'.' ||
                                s_[pos_] == L'e' || s_[pos_] == L'E' || s_[pos_] == L'-' ||
                                s_[pos_] == L'+')) {
      if (s_[pos_] >= L'0' && s_[pos_] <= L'9') digits = true;
      pos_++;
    }
    if (!digits) return false;
    v.type = JsonValue::Num;
    v.num = wcstod(s_.c_str() + start, nullptr);
    return true;
  }
};
std::wstring JsonParser::s_;
size_t JsonParser::pos_;

static void JsonEscape(const std::wstring& w, std::string& out) {
  out.push_back('"');
  for (wchar_t c : w) {
    switch (c) {
      case L'"': out += "\\\""; break;
      case L'\\': out += "\\\\"; break;
      case L'\b': out += "\\b"; break;
      case L'\f': out += "\\f"; break;
      case L'\n': out += "\\n"; break;
      case L'\r': out += "\\r"; break;
      case L'\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          sprintf_s(buf, "\\u%04x", (uint32_t)c);
          out += buf;
        } else {
          out += WideToUtf8(std::wstring(1, c));
        }
    }
  }
  out.push_back('"');
}

// ============================================================
// 帧 IO
// ============================================================
static HANDLE g_out = nullptr;            // launcher stdout（帧出口）
static SRWLOCK g_outLock = SRWLOCK_INIT;  // 多线程帧写入互斥

static bool ReadExact(HANDLE h, uint8_t* buf, uint32_t len) {
  uint32_t got = 0;
  while (got < len) {
    DWORD n = 0;
    if (!ReadFile(h, buf + got, len - got, &n, nullptr) || n == 0) return false;
    got += n;
  }
  return true;
}

static bool WriteAll(HANDLE h, const uint8_t* buf, uint32_t len) {
  uint32_t sent = 0;
  while (sent < len) {
    DWORD n = 0;
    if (!WriteFile(h, buf + sent, len - sent, &n, nullptr) || n == 0) return false;
    sent += n;
  }
  return true;
}

static bool WriteFrame(uint8_t type, const uint8_t* payload, uint32_t len) {
  uint8_t header[5];
  header[0] = type;
  header[1] = (uint8_t)(len & 0xFF);
  header[2] = (uint8_t)((len >> 8) & 0xFF);
  header[3] = (uint8_t)((len >> 16) & 0xFF);
  header[4] = (uint8_t)((len >> 24) & 0xFF);
  AcquireSRWLockExclusive(&g_outLock);
  bool ok = WriteAll(g_out, header, 5) && (len == 0 || WriteAll(g_out, payload, len));
  ReleaseSRWLockExclusive(&g_outLock);
  return ok;
}

static bool WriteFrameJson(uint8_t type, const std::string& utf8Json) {
  if (utf8Json.size() > MAX_JSON_PAYLOAD) return false;
  return WriteFrame(type, (const uint8_t*)utf8Json.data(), (uint32_t)utf8Json.size());
}

// 从 launcher 自身 stdin 读一帧；EOF/断开返回 false
static bool ReadFrameStdin(uint8_t* typeOut, std::vector<uint8_t>& payload) {
  uint8_t header[5];
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  if (!ReadExact(in, header, 5)) return false;
  *typeOut = header[0];
  uint32_t len = (uint32_t)header[1] | ((uint32_t)header[2] << 8) | ((uint32_t)header[3] << 16) |
                 ((uint32_t)header[4] << 24);
  if (len > MAX_DATA_PAYLOAD) return false;
  payload.assign(len, 0);
  if (len > 0 && !ReadExact(in, payload.data(), len)) return false;
  return true;
}

// ============================================================
// 错误上报与退出（协议/致命错误统一出口）
// ============================================================
[[noreturn]] static void FatalError(const char* code, const char* message, DWORD lastError,
                                    DWORD exitCode) {
  std::string json = "{\"code\":";
  JsonEscape(Utf8ToWide(code), json);
  json += ",\"win32LastError\":";
  char num[32];
  sprintf_s(num, "%lu", (unsigned long)lastError);
  json += num;
  json += ",\"message\":";
  JsonEscape(Utf8ToWide(message), json);
  json += "}";
  WriteFrameJson(FRAME_ERROR, json);
  ExitProcess(exitCode);
}

// ============================================================
// 请求解析与校验（范围校验见 docs/V1_3_JOB_OBJECT_DESIGN.md §3.2）
// ============================================================
struct Request {
  std::wstring program;
  std::vector<std::wstring> args;
  std::wstring cwd;
  std::vector<std::pair<std::wstring, std::wstring>> env;
  bool hasEnv = false;
  ULONGLONG timeoutMs = 10000;
  ULONGLONG memoryLimitBytes = 0;
  ULONGLONG processLimit = 0;
  ULONGLONG outputLimitBytes = 0;
};

static bool JsonToStr(const JsonValue* v, std::wstring& out) {
  if (v == nullptr || v->type != JsonValue::Str) return false;
  out = v->str;
  return true;
}

static bool JsonToU64(const JsonValue* v, ULONGLONG& out, ULONGLONG lo, ULONGLONG hi) {
  if (v == nullptr || v->type != JsonValue::Num) return false;
  if (v->num < 0) return false;
  ULONGLONG val = (ULONGLONG)v->num;
  if (val < lo || val > hi) return false;
  out = val;
  return true;
}

static bool ParseRequest(const std::string& utf8, Request& req) {
  JsonValue root;
  if (!JsonParser::Parse(utf8, root) || root.type != JsonValue::Obj) return false;
  const JsonValue* version = root.find(L"version");
  if (version == nullptr || version->type != JsonValue::Num ||
      (int)version->num != PROTOCOL_VERSION) {
    FatalError("unsupported_version", "REQ version must be 1", 0, EXIT_VERSION);
  }
  if (!JsonToStr(root.find(L"program"), req.program) || req.program.empty()) return false;
  // 契约：program 必须为绝对路径（lpApplicationName 不做 PATH 搜索）
  if (req.program.size() < 3 || req.program[1] != L':') return false;

  const JsonValue* args = root.find(L"args");
  if (args != nullptr) {
    if (args->type != JsonValue::Arr) return false;
    for (const auto& a : args->arr) {
      if (a.type != JsonValue::Str) return false;
      req.args.push_back(a.str);
    }
  }
  const JsonValue* cwd = root.find(L"cwd");
  if (cwd != nullptr && cwd->type == JsonValue::Str) req.cwd = cwd->str;

  const JsonValue* env = root.find(L"env");
  if (env != nullptr) {
    if (env->type != JsonValue::Obj) return false;
    for (const auto& kv : env->obj) req.env.emplace_back(kv.first, kv.second.str);
    req.hasEnv = true;
  }

  if (!JsonToU64(root.find(L"timeoutMs"), req.timeoutMs, 1, 600000)) return false;
  if (!JsonToU64(root.find(L"memoryLimitBytes"), req.memoryLimitBytes, 0,
                 4ULL * 1024 * 1024 * 1024)) {
    return false;
  }
  if (!JsonToU64(root.find(L"processLimit"), req.processLimit, 0, 4096)) return false;
  if (!JsonToU64(root.find(L"outputLimitBytes"), req.outputLimitBytes, 0, 64ULL * 1024 * 1024)) {
    return false;
  }
  return true;
}

// ============================================================
// argv quoting（标准 MSVCRT 规则，与 PoC 同实现）
// ============================================================
static std::wstring QuoteArg(const std::wstring& arg) {
  if (arg.empty()) return L"\"\"";
  bool needQuotes = false;
  for (wchar_t c : arg) {
    if (c == L' ' || c == L'\t' || c == L'"') {
      needQuotes = true;
      break;
    }
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
      out.append(backslashes * 2 + 1, L'\\');
      out.push_back(L'"');
    } else {
      out.append(backslashes, L'\\');
      out.push_back(c);
    }
    backslashes = 0;
  }
  out.append(backslashes * 2, L'\\');
  out.push_back(L'"');
  return out;
}

// ============================================================
// 环境块（键不区分大小写排序去重，UTF-16，双 NUL 结尾，≤1MB）
// ============================================================
struct ICaseLess {
  bool operator()(const std::wstring& a, const std::wstring& b) const {
    return _wcsicmp(a.c_str(), b.c_str()) < 0;
  }
};

static std::wstring BuildEnvBlock(const Request& req) {
  std::map<std::wstring, std::wstring, ICaseLess> sorted;
  for (const auto& kv : req.env) sorted[kv.first] = kv.second;
  std::wstring block;
  for (const auto& kv : sorted) {
    if (kv.first.size() > 32767 || kv.second.size() > 32767) continue;
    block += kv.first;
    block += L'=';
    block += kv.second;
    block += L'\0';
    if (block.size() > 1024 * 1024) break;
  }
  block += L'\0';
  return block;
}

// ============================================================
// 子进程创建（CREATE_SUSPENDED + 句柄白名单）
// ============================================================
struct Child {
  HANDLE job = nullptr;
  HANDLE process = nullptr;
  HANDLE thread = nullptr;
  HANDLE stdinWrite = nullptr;
  HANDLE stdoutRead = nullptr;
  HANDLE stderrRead = nullptr;
  DWORD pid = 0;
};

static void CreateJobWithLimits(const Request& req, Child& c) {
  c.job = CreateJobObjectW(nullptr, nullptr);
  if (c.job == nullptr) {
    FatalError("create_job_failed", "CreateJobObjectW failed", GetLastError(), EXIT_FATAL);
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION ext{};
  ext.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  if (req.processLimit > 0) {
    ext.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    ext.BasicLimitInformation.ActiveProcessLimit = (DWORD)req.processLimit;
  }
  if (req.memoryLimitBytes > 0) {
    ext.BasicLimitInformation.LimitFlags |=
        JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY;
    ext.ProcessMemoryLimit = req.memoryLimitBytes;
    ext.JobMemoryLimit = req.memoryLimitBytes;
  }
  if (!SetInformationJobObject(c.job, JobObjectExtendedLimitInformation, &ext, sizeof(ext))) {
    DWORD err = GetLastError();
    CloseHandle(c.job);
    c.job = nullptr;
    FatalError("set_job_limits_failed", "SetInformationJobObject failed", err, EXIT_FATAL);
  }
}

// 管道对：inheritWhich=0 读端可继承（子 stdin）、1 写端可继承（子 stdout/stderr）
static bool CreatePipePair(HANDLE* readEnd, HANDLE* writeEnd, int inheritWhich) {
  SECURITY_ATTRIBUTES sa{};
  sa.nLength = sizeof(sa);
  sa.bInheritHandle = TRUE;
  HANDLE r = nullptr;
  HANDLE w = nullptr;
  if (!CreatePipe(&r, &w, &sa, 512 * 1024)) return false;
  HANDLE keepInherit = inheritWhich == 0 ? r : w;
  HANDLE dropInherit = inheritWhich == 0 ? w : r;
  if (!SetHandleInformation(dropInherit, HANDLE_FLAG_INHERIT, 0)) {
    DWORD err = GetLastError();
    CloseHandle(r);
    CloseHandle(w);
    SetLastError(err);
    return false;
  }
  (void)keepInherit;
  *readEnd = r;
  *writeEnd = w;
  return true;
}

static void CreateChildSuspended(const Request& req, Child& c) {
  HANDLE stdinR = nullptr, stdinW = nullptr;
  HANDLE stdoutR = nullptr, stdoutW = nullptr;
  HANDLE stderrR = nullptr, stderrW = nullptr;
  if (!CreatePipePair(&stdinR, &stdinW, 0) || !CreatePipePair(&stdoutR, &stdoutW, 1) ||
      !CreatePipePair(&stderrR, &stderrW, 1)) {
    DWORD err = GetLastError();
    if (stdinR) CloseHandle(stdinR);
    if (stdinW) CloseHandle(stdinW);
    if (stdoutR) CloseHandle(stdoutR);
    if (stdoutW) CloseHandle(stdoutW);
    if (stderrR) CloseHandle(stderrR);
    if (stderrW) CloseHandle(stderrW);
    FatalError("create_pipe_failed", "CreatePipe failed", err, EXIT_FATAL);
  }

  std::wstring cmdline = QuoteArg(req.program);
  for (const auto& a : req.args) {
    cmdline += L" ";
    cmdline += QuoteArg(a);
  }
  std::wstring envBlock;
  const wchar_t* envPtr = nullptr;
  if (req.hasEnv) {
    envBlock = BuildEnvBlock(req);
    envPtr = envBlock.c_str();
  }

  STARTUPINFOEXW si{};
  si.StartupInfo.cb = sizeof(si);
  si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = stdinR;
  si.StartupInfo.hStdOutput = stdoutW;
  si.StartupInfo.hStdError = stderrW;

  // P14 句柄白名单：仅三个子 stdio 句柄可进入子进程
  HANDLE allowlist[3] = {stdinR, stdoutW, stderrW};
  SIZE_T attrSize = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attrSize);
  auto attrList = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, attrSize);
  if (attrList == nullptr) {
    FatalError("internal_error", "HeapAlloc failed", ERROR_OUTOFMEMORY, EXIT_FATAL);
  }
  if (!InitializeProcThreadAttributeList(attrList, 1, 0, &attrSize) ||
      !UpdateProcThreadAttribute(attrList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, allowlist,
                                 sizeof(allowlist), nullptr, nullptr)) {
    DWORD err = GetLastError();
    HeapFree(GetProcessHeap(), 0, attrList);
    FatalError("internal_error", "attribute list init failed", err, EXIT_FATAL);
  }
  si.lpAttributeList = attrList;

  std::wstring programAbs = req.program;
  const wchar_t* cwdPtr = req.cwd.empty() ? nullptr : req.cwd.c_str();
  PROCESS_INFORMATION pi{};
  BOOL ok = CreateProcessW(programAbs.c_str(), &cmdline[0], nullptr, nullptr, TRUE,
                           CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT |
                               CREATE_UNICODE_ENVIRONMENT,
                           (void*)envPtr, cwdPtr, &si.StartupInfo, &pi);
  DWORD createErr = GetLastError();
  DeleteProcThreadAttributeList(attrList);
  HeapFree(GetProcessHeap(), 0, attrList);
  // 父端关闭子端副本：管道 EOF 严格跟随子进程存活期
  CloseHandle(stdinR);
  CloseHandle(stdoutW);
  CloseHandle(stderrW);
  if (!ok) {
    CloseHandle(stdinW);
    CloseHandle(stdoutR);
    CloseHandle(stderrR);
    FatalError("create_process_failed", "CreateProcessW failed", createErr, EXIT_FATAL);
  }
  c.process = pi.hProcess;
  c.thread = pi.hThread;
  c.pid = pi.dwProcessId;
  c.stdinWrite = stdinW;
  c.stdoutRead = stdoutR;
  c.stderrRead = stderrR;
}

// ============================================================
// 运行状态（线程间共享）
// ============================================================
struct RunState {
  std::atomic<bool> outputLimitExceeded{false};
  std::atomic<uint8_t> outputLimitStream{0};  // 1=stdout 2=stderr（证据上报）
  std::atomic<bool> pollDone{false};
  std::atomic<ULONGLONG> peakProcessCount{0};
  ULONGLONG outputLimitBytes = 0;
  HANDLE job = nullptr;
};

static void NoteProcessCount(RunState& st) {
  uint8_t buf[4096];
  DWORD ret = 0;
  if (QueryInformationJobObject(st.job, JobObjectBasicProcessIdList, buf, sizeof(buf), &ret)) {
    auto list = (JOBOBJECT_BASIC_PROCESS_ID_LIST*)buf;
    ULONGLONG n = list->NumberOfProcessIdsInList;
    ULONGLONG prev = st.peakProcessCount.load();
    while (n > prev && !st.peakProcessCount.compare_exchange_weak(prev, n)) {
    }
  }
}

static void EnforceOutputLimit(RunState& st, uint8_t stream) {
  if (st.outputLimitExceeded.exchange(true)) return;
  st.outputLimitStream = stream;
  if (st.job != nullptr) TerminateJobObject(st.job, 2);
}

// stdin 转发线程：STDIN 帧 → 子进程 stdin；EOF/断开 → 关闭写端。
// 写失败（子进程不读）转排水模式继续读到 EOF，防 Node 侧写阻塞。
static void StdinThread(Child c) {
  uint8_t type = 0;
  std::vector<uint8_t> payload;
  for (;;) {
    if (!ReadFrameStdin(&type, payload)) break;
    if (type == FRAME_STDIN_EOF) break;
    if (type != FRAME_STDIN) continue;
    uint32_t sent = 0;
    while (sent < payload.size()) {
      DWORD n = 0;
      if (!WriteFile(c.stdinWrite, payload.data() + sent, (DWORD)(payload.size() - sent), &n,
                     nullptr) ||
          n == 0) {
        break;
      }
      sent += n;
    }
  }
  CloseHandle(c.stdinWrite);
}

// stdout/stderr 读线程：ReadFile → 帧回传；累计超 launcher 层上限 → 整树终止 + 排水
static void StreamThread(HANDLE readEnd, uint8_t frameType, RunState& st) {
  uint8_t buf[64 * 1024];
  ULONGLONG total = 0;
  for (;;) {
    DWORD n = 0;
    if (!ReadFile(readEnd, buf, sizeof(buf), &n, nullptr) || n == 0) break;
    if (st.outputLimitBytes > 0 && total + (ULONGLONG)n > st.outputLimitBytes) {
      ULONGLONG room = st.outputLimitBytes > total ? (st.outputLimitBytes - total) : 0;
      if (room > 0) WriteFrame(frameType, buf, (uint32_t)room);
      total += (ULONGLONG)n;
      EnforceOutputLimit(st, frameType == FRAME_STDOUT ? 1 : 2);
      continue;  // 排水不转发
    }
    total += (ULONGLONG)n;
    if (!WriteFrame(frameType, buf, n)) break;
  }
  CloseHandle(readEnd);
}

static void PollThread(RunState& st) {
  // 20ms 粒度：进程数峰值证据足够；间隔过长会在收尾 join 时引入同量级延迟
  // （pollDone 置位后仍需等完当前 Sleep——实测 200ms 粒度即 200ms 级退出延迟）
  while (!st.pollDone.load()) {
    NoteProcessCount(st);
    Sleep(20);
  }
  NoteProcessCount(st);
}

// ============================================================
// main
// ============================================================
static int dbg(const char* tag, ULONGLONG t0) {
  if (GetEnvironmentVariableA("CCB_DEBUG_TIMING", nullptr, 0) == 0) return 0;
  char buf[128];
  sprintf_s(buf, "[launcher-timing] %s: %llu ms\n", tag, (unsigned long long)(GetTickCount64() - t0));
  fprintf(stderr, "%s", buf);
  return 0;
}

int wmain() {
  const ULONGLONG T0 = GetTickCount64();
  g_out = GetStdHandle(STD_OUTPUT_HANDLE);

  // 1) 首帧 REQ（严格一帧，≤16KB）
  uint8_t type = 0;
  std::vector<uint8_t> payload;
  if (!ReadFrameStdin(&type, payload)) {
    FatalError("invalid_request", "missing REQ frame", 0, EXIT_PROTOCOL);
  }
  if (type != FRAME_REQ) {
    FatalError("invalid_request", "first frame must be REQ", 0, EXIT_PROTOCOL);
  }
  if (payload.size() > MAX_JSON_PAYLOAD) {
    FatalError("frame_too_large", "REQ payload too large", 0, EXIT_PROTOCOL);
  }
  Request req;
  if (!ParseRequest(std::string((const char*)payload.data(), payload.size()), req)) {
    FatalError("invalid_request", "REQ validation failed", 0, EXIT_PROTOCOL);
  }

  // 2) Job + 限制
  Child c;
  CreateJobWithLimits(req, c);

  RunState st;
  st.job = c.job;
  st.outputLimitBytes = req.outputLimitBytes;

  // 3) CREATE_SUSPENDED 创建（白名单句柄）
  ULONGLONG startedAt = GetTickCount64();
  dbg("req-parsed", T0);
  CreateChildSuspended(req, c);
  dbg("child-created", T0);

  // 4) Resume 前入 Job（无竞态核心：子进程首条指令前已在 Job 内）→ Resume
  if (!AssignProcessToJobObject(c.job, c.process)) {
    DWORD err = GetLastError();
    TerminateProcess(c.process, 1);
    CloseHandle(c.thread);
    CloseHandle(c.process);
    FatalError("assign_job_failed", "AssignProcessToJobObject failed", err, EXIT_FATAL);
  }
  if (ResumeThread(c.thread) == (DWORD)-1) {
    DWORD err = GetLastError();
    TerminateJobObject(c.job, 1);
    CloseHandle(c.thread);
    CloseHandle(c.process);
    FatalError("resume_thread_failed", "ResumeThread failed", err, EXIT_FATAL);
  }
  CloseHandle(c.thread);
  dbg("resumed", T0);

  // 5) INFO：childPid（Node 看门狗/兜底清理依赖）
  {
    std::string info = "{\"childPid\":";
    char num[32];
    sprintf_s(num, "%lu", (unsigned long)c.pid);
    info += num;
    info += "}";
    if (!WriteFrameJson(FRAME_INFO, info)) {
      // Node 侧已断开：收尾退出（Job 兜底杀树）
      TerminateJobObject(c.job, 1);
      CloseHandle(c.process);
      CloseHandle(c.job);
      return EXIT_OK;
    }
  }

  // 6) IO 线程
  std::thread stdinThread(StdinThread, c);
  std::thread stdoutThread(StreamThread, c.stdoutRead, FRAME_STDOUT, std::ref(st));
  std::thread stderrThread(StreamThread, c.stderrRead, FRAME_STDERR, std::ref(st));
  std::thread pollThread(PollThread, std::ref(st));

  // 7) 等待子进程（timeout 权威在 launcher）
  bool timedOut = false;
  DWORD wait = WaitForSingleObject(c.process, (DWORD)req.timeoutMs);
  if (wait == WAIT_FAILED) {
    st.pollDone = true;
    pollThread.join();
    DWORD err = GetLastError();
    TerminateJobObject(c.job, 1);
    FatalError("wait_failed", "WaitForSingleObject failed", err, EXIT_FATAL);
  }
  if (wait == WAIT_TIMEOUT) {
    timedOut = true;
    TerminateJobObject(c.job, 1);
    WaitForSingleObject(c.process, 5000);
  }
  dbg("child-exit-noticed", T0);

  // 8) 主子进程已退出但孙进程仍持管道 → EOF 最多等 2s，超时终止 Job（判题语义：
  //    主程序退出即用例结束；孤儿孙进程不改变结果，必须收干净）
  st.pollDone = true;
  if (!timedOut) {
    if (WaitForSingleObject(c.process, 2000) == WAIT_TIMEOUT) {
      // 不可达（已 signaled）；防御
    }
    // 孙进程若仍存活：进程句柄已 signaled 不代表管道关闭——直接终止 Job 再收尾
    // （正常路径：子进程退出 → 孙进程无外力时也退出 → 管道 EOF；持管道不退 = 违约）
    if (WaitForSingleObject(c.process, 0) == WAIT_OBJECT_0) {
      // 检查 Job 是否还有进程：有则终止（等待管道线程自然收尾见下方 join 超时保护）
      TerminateJobObject(c.job, 0);
    }
  }

  // 9) 记账 + 终态
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION ext{};
  QueryInformationJobObject(c.job, JobObjectExtendedLimitInformation, &ext, sizeof(ext), nullptr);
  ULONGLONG peakMem = ext.PeakProcessMemoryUsed;
  DWORD exitCode = 0;
  if (!GetExitCodeProcess(c.process, &exitCode)) exitCode = -1;

  // IO 线程在 Job 终止后管道断开自然退出；等待收尾
  stdinThread.join();
  dbg("stdin-joined", T0);
  stdoutThread.join();
  stderrThread.join();
  pollThread.join();
  dbg("io-joined", T0);
  NoteProcessCount(st);

  ULONGLONG durationMs = GetTickCount64() - startedAt;

  // terminationReason 证据链（优先级：timeout > output_limit > memory > process）
  const char* reason = nullptr;
  bool abnormal = exitCode != 0 && exitCode != (DWORD)-1;
  if (timedOut) {
    reason = "timeout";
  } else if (st.outputLimitExceeded.load()) {
    reason = "output_limit";
  } else if (req.memoryLimitBytes > 0 && abnormal &&
             peakMem >= (req.memoryLimitBytes / 100) * 98) {
    reason = "memory_limit";
  } else if (req.processLimit > 0 && abnormal &&
             st.peakProcessCount.load() >= req.processLimit) {
    reason = "process_limit";
  }

  // 10) RESULT（终帧）
  std::string result = "{\"exitCode\":";
  char num[32];
  sprintf_s(num, "%lu", (unsigned long)exitCode);
  result += num;
  result += timedOut ? ",\"timedOut\":true" : ",\"timedOut\":false";
  result += st.outputLimitExceeded.load() ? ",\"outputLimitExceeded\":true"
                                          : ",\"outputLimitExceeded\":false";
  if (st.outputLimitExceeded.load()) {
    sprintf_s(num, "%u", (unsigned)st.outputLimitStream.load());
    result += ",\"outputLimitStream\":";
    result += num;
  } else {
    result += ",\"outputLimitStream\":null";
  }
  sprintf_s(num, "%llu", (unsigned long long)durationMs);
  result += ",\"durationMs\":";
  result += num;
  sprintf_s(num, "%llu", (unsigned long long)peakMem);
  result += ",\"peakProcessMemoryBytes\":";
  result += num;
  sprintf_s(num, "%llu", (unsigned long long)st.peakProcessCount.load());
  result += ",\"peakProcessCount\":";
  result += num;
  result += ",\"terminationReason\":";
  if (reason != nullptr) {
    JsonEscape(Utf8ToWide(reason), result);
  } else {
    result += "null";
  }
  result += "}";

  dbg("result-built", T0);
  CloseHandle(c.process);
  CloseHandle(c.job);  // 正常收尾：树已退出
  dbg("handles-closed", T0);
  if (!WriteFrameJson(FRAME_RESULT, result)) {
    // Node 已断开：数据无法送达，静默退出（KILL_ON_JOB_CLOSE 已清场）
    return EXIT_OK;
  }
  return EXIT_OK;
}
