import { beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDatabase } from '../src/main/db/connection'
import { LearningRepository } from '../src/main/db/repositories/learning-repository'
import { SettingsRepository } from '../src/main/db/repositories/settings-repository'
import {
  resolveLearningSeedFile,
  runLearningSeedStep,
  type SeedMarkerStore
} from '../src/main/learning/learning-seed'

/**
 * v1.2.1 P0-B 回归：学习路线 seed 的 marker 语义。
 * 修复前缺陷：src/main/index.ts 的 finally 块无条件 markMarker——
 * seed 失败（JSON 损坏等）也被标记成功，「下次启动重试」永不发生。
 */

const VALID_SEED = {
  seedVersion: 2,
  path: { slug: 'c-basics', title: 'C 基础', description: '测试' },
  stages: [
    {
      slug: 'getting-started',
      title: '起步',
      description: '',
      knowledgePoints: [{ slug: 'io', name: '输入输出', description: '', tags: ['io'] }]
    }
  ],
  builtinProblemMap: {}
}

function makeFixture(): {
  db: Database.Database
  settings: SeedMarkerStore
  repo: LearningRepository
  seedFile: string
} {
  const db = openDatabase({ file: ':memory:' })
  const settingsRepo = new SettingsRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'ccb-seed-test-'))
  mkdirSync(join(dir, 'resources'), { recursive: true })
  // dev 模式（isPackaged=false）：appPath/resources/seed-learning-path.json
  const seedFile = resolveLearningSeedFile(false, dir, dir)
  return { db, settings: settingsRepo, repo: new LearningRepository(db), seedFile }
}

describe('runLearningSeedStep marker 语义（P0-B）', () => {
  let fixture: ReturnType<typeof makeFixture>

  beforeEach(() => {
    fixture = makeFixture()
  })

  it('成功：灌入并标记 marker', () => {
    writeFileSync(fixture.seedFile, JSON.stringify(VALID_SEED), 'utf-8')
    const outcome = runLearningSeedStep(fixture.settings, fixture.repo, 'learning_v2_mapped', fixture.seedFile)
    expect(outcome).toBe('seeded')
    expect(fixture.settings.hasMarker('learning_v2_mapped')).toBe(true)
    expect(fixture.repo.listPaths()).toHaveLength(1)
    // 再次运行：marker 命中，直接跳过
    const again = runLearningSeedStep(fixture.settings, fixture.repo, 'learning_v2_mapped', fixture.seedFile)
    expect(again).toBe('seeded')
  })

  it('JSON 损坏：失败、不标记 marker → 下次启动真实重试（修复前：标记导致永不重试）', () => {
    writeFileSync(fixture.seedFile, '{ corrupted !!!', 'utf-8')
    expect(runLearningSeedStep(fixture.settings, fixture.repo, 'learning_v2_mapped', fixture.seedFile)).toBe('failed')
    expect(fixture.settings.hasMarker('learning_v2_mapped')).toBe(false)

    // 修复文件后「下次启动」重试成功
    writeFileSync(fixture.seedFile, JSON.stringify(VALID_SEED), 'utf-8')
    expect(runLearningSeedStep(fixture.settings, fixture.repo, 'learning_v2_mapped', fixture.seedFile)).toBe('seeded')
    expect(fixture.repo.listPaths()).toHaveLength(1)
  })

  it('schema 校验失败（结构合法但内容不合规）：失败、不标记 marker', () => {
    // slug 含非法字符 → zod 拒绝
    writeFileSync(fixture.seedFile, JSON.stringify({ ...VALID_SEED, path: { ...VALID_SEED.path, slug: 'C_Basics!' } }), 'utf-8')
    expect(runLearningSeedStep(fixture.settings, fixture.repo, 'learning_v2_mapped', fixture.seedFile)).toBe('failed')
    expect(fixture.settings.hasMarker('learning_v2_mapped')).toBe(false)
  })

  it('文件不存在：missing、不标记 marker（下次启动再探测）', () => {
    expect(runLearningSeedStep(fixture.settings, fixture.repo, 'learning_v2_mapped', fixture.seedFile)).toBe('missing')
    expect(fixture.settings.hasMarker('learning_v2_mapped')).toBe(false)
    // 文件出现后下次启动可灌入
    writeFileSync(fixture.seedFile, JSON.stringify(VALID_SEED), 'utf-8')
    expect(runLearningSeedStep(fixture.settings, fixture.repo, 'learning_v2_mapped', fixture.seedFile)).toBe('seeded')
  })

  it('marker 已存在：不读文件、直接跳过（seed 文件损坏也不受影响）', () => {
    writeFileSync(fixture.seedFile, JSON.stringify(VALID_SEED), 'utf-8')
    runLearningSeedStep(fixture.settings, fixture.repo, 'learning_v2_mapped', fixture.seedFile)
    writeFileSync(fixture.seedFile, 'broken', 'utf-8')
    expect(runLearningSeedStep(fixture.settings, fixture.repo, 'learning_v2_mapped', fixture.seedFile)).toBe('seeded')
  })
})
