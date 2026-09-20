import type { LanguageId, Toolchain } from '@shared/types'
import { detectAllToolchains } from '../runner/detect'
import { TOOLCHAIN_LANGUAGES, TOOLCHAIN_PRIORITY } from '../runner/languages'

/**
 * 工具链服务：探测结果内存缓存；手工指定路径优先（FR-R10）。
 */

export class ToolchainService {
  private cache: Toolchain[] | null = null
  private detecting: Promise<Toolchain[]> | null = null

  constructor(private readonly getManual: () => Partial<Record<LanguageId, string>>) {}

  /** 探测（缓存命中直接返回；force 重扫） */
  async detectAll(force: boolean): Promise<Toolchain[]> {
    if (!force && this.cache !== null) return this.cache
    if (this.detecting !== null) return this.detecting

    this.detecting = (async () => {
      const auto = await detectAllToolchains()
      const withManual = this.mergeManual(auto)
      this.cache = withManual
      return withManual
    })()

    try {
      return await this.detecting
    } finally {
      this.detecting = null
    }
  }

  /** 取当前可用工具链（缓存优先，未探测过则即时探测） */
  async available(): Promise<Toolchain[]> {
    return this.detectAll(false)
  }

  /** 为指定语言选择工具链（手工指定 > 自动优先级） */
  async select(language: LanguageId): Promise<Toolchain | null> {
    const all = await this.available()
    const fitting = all.filter((t) => t.languageIds.includes(language))
    if (fitting.length === 0) return null
    const manual = this.getManual()[language]
    if (manual !== undefined) {
      const manualHit = fitting.find(
        (t) => t.program.toLowerCase() === manual.toLowerCase() || t.source === 'manual'
      )
      if (manualHit !== undefined) return manualHit
    }
    return fitting.sort((a, b) => TOOLCHAIN_PRIORITY[a.kind] - TOOLCHAIN_PRIORITY[b.kind])[0] ?? null
  }

  /** 手工路径合并进结果（标记 source=manual；若与自动探测同路径则升级标记） */
  private mergeManual(auto: Toolchain[]): Toolchain[] {
    const manual = this.getManual()
    const merged = [...auto]
    for (const [lang, program] of Object.entries(manual)) {
      if (program === undefined || program.trim() === '') continue
      const languageId = lang as LanguageId
      const kinds = (Object.keys(TOOLCHAIN_LANGUAGES) as Toolchain['kind'][]).filter((k) =>
        TOOLCHAIN_LANGUAGES[k].includes(languageId)
      )
      const kind = kinds[0]
      if (kind === undefined) continue
      const existing = merged.findIndex(
        (t) => t.program.toLowerCase() === program.toLowerCase() && t.languageIds.includes(languageId)
      )
      if (existing >= 0) {
        const found = merged[existing]
        if (found !== undefined) {
          merged[existing] = { ...found, source: 'manual' }
        }
      } else {
        merged.push({
          id: `${kind}:${program}`,
          languageIds: [languageId],
          kind,
          program,
          version: '手工指定',
          source: 'manual'
        })
      }
    }
    return merged
  }
}
