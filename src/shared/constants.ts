/**
 * 全局常量：三端共用，禁止放可变状态。
 */

/** 应用显示名 */
export const APP_NAME = 'CuinCodeBench'

/** 支持的语言（与 LanguageId 保持一致的顺序） */
export const LANGUAGE_IDS = ['c', 'cpp', 'python'] as const

/** 单路输出捕获上限（字节）：超出即杀进程（FR-R6 / SECURITY §3.3） */
export const OUTPUT_LIMIT_BYTES = 1024 * 1024

/**
 * 编译阶段单路输出上限（字节）：防失控编译器无限输出（H6）。
 * 常规警告/错误远小于此值；巨大模板错误会被截断并标记。
 */
export const COMPILE_OUTPUT_LIMIT_BYTES = 1024 * 1024

/** 展示层单块文本截断长度（字符）：防止 UI 渲染卡死 */
export const DISPLAY_TRUNCATE_CHARS = 64 * 1024

/** 编译默认超时（毫秒） */
export const COMPILE_TIMEOUT_MS = 30_000

/** 工具链版本探测超时（毫秒） */
export const DETECT_TIMEOUT_MS = 5_000

/** 新测试用例默认运行超时（毫秒），可配置范围见 AppSettings */
export const DEFAULT_TESTCASE_TIMEOUT_MS = 5_000

/** 测试用例超时允许范围（毫秒） */
export const TESTCASE_TIMEOUT_MIN_MS = 100
export const TESTCASE_TIMEOUT_MAX_MS = 60_000

/** 每题测试用例数量上限（ARCHITECTURE §5.7） */
export const MAX_TEST_CASES_PER_PROBLEM = 50

/** 错题进入错题本的失败次数阈值（FR-M2） */
export const MISTAKE_THRESHOLD = 2

/** mastered 掌握度惰性衰减阈值（天）：超过该天数无活动降为 familiar（读侧同样生效，P1-B） */
export const MASTERY_STALE_DAYS = 45

/** 编辑器字号允许范围（px） */
export const FONT_SIZE_MIN = 12
export const FONT_SIZE_MAX = 28

/** 判题默认超时允许范围（毫秒，设置项） */
export const JUDGE_TIMEOUT_MIN_MS = 1_000
export const JUDGE_TIMEOUT_MAX_MS = 60_000

/** 提交历史单页条数 */
export const HISTORY_PAGE_SIZE = 20

/** 临时目录根名（位于系统临时目录下） */
export const TEMP_ROOT_NAME = 'cuincodebench'

// ============================================================
// v1.3 Native Launcher（docs/V1_3_JOB_OBJECT_DESIGN.md）
// ============================================================

/** 判题子进程树内存上限（字节）：Job PROCESS/JOB_MEMORY，默认 512MB */
export const LAUNCHER_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024

/** 判题子进程树进程数上限：Job ACTIVE_PROCESS_LIMIT，默认 32 */
export const LAUNCHER_PROCESS_LIMIT = 32

/** Node 看门狗宽限（毫秒）：launcher 超时后额外等待 RESULT 的余量，超时杀 launcher 兜底 */
export const LAUNCHER_WATCHDOG_GRACE_MS = 5_000
