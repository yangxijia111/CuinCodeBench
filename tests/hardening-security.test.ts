import { describe, expect, it } from 'vitest'
import { isAllowedExternalUrl } from '../src/main/lib/external-url'
import { isTrustedFrameUrl } from '../src/main/ipc/validate-sender'

/**
 * v1.1 Hardening 回归测试（H2 外部 URL 白名单 / H3 IPC frame URL 校验）。
 * 全部为恶意与异常输入，不测 happy path 之外忽略任何拒绝分支。
 */

describe('isAllowedExternalUrl（shell.openExternal 协议白名单）', () => {
  it('https 允许', () => {
    expect(isAllowedExternalUrl('https://example.com')).toBe(true)
    expect(isAllowedExternalUrl('https://example.com/docs?q=1#top')).toBe(true)
  })

  it('http 允许', () => {
    expect(isAllowedExternalUrl('http://example.com')).toBe(true)
  })

  it('javascript: 拒绝', () => {
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedExternalUrl('JavaScript:alert(1)')).toBe(false)
  })

  it('file: 拒绝', () => {
    expect(isAllowedExternalUrl('file:///C:/Windows/System32/config')).toBe(false)
    expect(isAllowedExternalUrl('file://localhost/etc/passwd')).toBe(false)
  })

  it('data: 拒绝', () => {
    expect(isAllowedExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
  })

  it('vbscript:/shell:/ms-settings:/powershell:/cmd: 拒绝', () => {
    expect(isAllowedExternalUrl('vbscript:MsgBox(1)')).toBe(false)
    expect(isAllowedExternalUrl('shell:DocumentsFolder')).toBe(false)
    expect(isAllowedExternalUrl('ms-settings:windowsupdate')).toBe(false)
    expect(isAllowedExternalUrl('powershell:-c whoami')).toBe(false)
    expect(isAllowedExternalUrl('cmd:/c calc')).toBe(false)
  })

  it('自定义未知协议拒绝', () => {
    expect(isAllowedExternalUrl('myapp://callback?token=x')).toBe(false)
    expect(isAllowedExternalUrl('vscode://file/path')).toBe(false)
  })

  it('畸形与空输入拒绝', () => {
    expect(isAllowedExternalUrl('')).toBe(false)
    expect(isAllowedExternalUrl('   ')).toBe(false)
    expect(isAllowedExternalUrl('not a url')).toBe(false)
    expect(isAllowedExternalUrl('https://')).toBe(false)
  })
})

describe('isTrustedFrameUrl（IPC sender frame 校验）', () => {
  const devOrigin = 'http://localhost:5173'

  it('生产 file: 页面允许', () => {
    expect(isTrustedFrameUrl('file:///C:/app/out/renderer/index.html#/problems', null)).toBe(true)
  })

  it('开发 dev server origin 允许', () => {
    expect(isTrustedFrameUrl('http://localhost:5173/#/problems', devOrigin)).toBe(true)
  })

  it('dev origin 不匹配拒绝（端口不同）', () => {
    expect(isTrustedFrameUrl('http://localhost:9999/#/problems', devOrigin)).toBe(false)
    expect(isTrustedFrameUrl('http://127.0.0.1:5173/#/problems', devOrigin)).toBe(false)
  })

  it('生产模式下 http 页面拒绝', () => {
    expect(isTrustedFrameUrl('http://localhost:5173/#/problems', null)).toBe(false)
  })

  it('外部网页与恶意协议拒绝', () => {
    expect(isTrustedFrameUrl('https://evil.example.com/', devOrigin)).toBe(false)
    expect(isTrustedFrameUrl('javascript:void(0)', devOrigin)).toBe(false)
    expect(isTrustedFrameUrl('data:text/html,x', devOrigin)).toBe(false)
  })

  it('畸形 URL 拒绝', () => {
    expect(isTrustedFrameUrl('', devOrigin)).toBe(false)
    expect(isTrustedFrameUrl('not-a-url', devOrigin)).toBe(false)
  })
})
