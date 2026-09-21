// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { renderMarkdownToSafeHtml } from '../src/renderer/src/lib/sanitize-markdown'
import { MarkdownView } from '../src/renderer/src/components/MarkdownView'

/**
 * Markdown XSS 回归测试（H5）：恶意 Markdown/HTML 输入不得进入可执行状态。
 */

afterEach(() => {
  cleanup()
})

describe('renderMarkdownToSafeHtml（净化纯函数）', () => {
  it('普通 Markdown 正常渲染', () => {
    const html = renderMarkdownToSafeHtml('# 标题\n\n**粗体** 与 `code`')
    expect(html).toContain('<h1>')
    expect(html).toContain('<strong>')
    expect(html).toContain('<code>')
  })

  it('<script> 标签被移除', () => {
    const html = renderMarkdownToSafeHtml('hello <script>alert(1)</script> world')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)</script>')
  })

  it('img onerror 事件属性被移除', () => {
    const html = renderMarkdownToSafeHtml('<img src="x.png" onerror="alert(1)">')
    expect(html).not.toContain('onerror')
    expect(html.toLowerCase()).toContain('<img')
  })

  it('iframe/form/object/embed/svg/math/style 被移除', () => {
    const html = renderMarkdownToSafeHtml(
      '<iframe src="https://evil.example.com"></iframe><form action="/x"></form>' +
        '<object data="x"></object><embed src="x"><svg onload="alert(1)"></svg>' +
        '<math href="javascript:alert(1)">x</math><style>body{display:none}</style>'
    )
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('<object')
    expect(html).not.toContain('<embed')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('<math')
    expect(html).not.toContain('<style')
  })

  it('javascript: 链接被清除（href 不可执行）', () => {
    const html = renderMarkdownToSafeHtml('[点我](javascript:alert(1))')
    expect(html.toLowerCase()).not.toContain('javascript:')
    // 链接文本保留但不再可点击跳转恶意协议
    expect(html).toContain('点我')
  })

  it('data: URL 链接被清除', () => {
    const html = renderMarkdownToSafeHtml('[x](data:text/html;base64,PHNjcmlwdD4)')
    expect(html.toLowerCase()).not.toContain('data:text/html')
  })

  it('http/https 链接保留', () => {
    const html = renderMarkdownToSafeHtml('[官网](https://example.com)')
    expect(html).toContain('https://example.com')
  })

  it('onclick 等内联事件被移除', () => {
    const html = renderMarkdownToSafeHtml('<a href="https://example.com" onclick="alert(1)">x</a>')
    expect(html).not.toContain('onclick')
    expect(html).toContain('href')
  })
})

describe('MarkdownView（组件级）', () => {
  it('渲染后的 DOM 不含 script 元素', () => {
    const { container } = render(<MarkdownView text={'正文 <script>alert(1)</script> 尾部'} />)
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('正文')
  })

  it('空文本渲染空容器', () => {
    const { container } = render(<MarkdownView text="" />)
    expect(container.querySelector('.markdown')).toBeNull()
  })
})
