import { Component } from 'react'

/**
 * 顶层 ErrorBoundary（ARCHITECTURE §6）：渲染异常时展示可读错误而非白屏。
 */

interface Props {
  children: React.ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('渲染异常', error.message, info.componentStack)
  }

  override render(): React.ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="app-shell">
          <h2>界面出现异常</h2>
          <p className="subtitle">{this.state.error.message}</p>
          <button onClick={() => this.setState({ error: null })}>重试</button>
          <button
            onClick={() => {
              window.location.hash = '#/problems'
              this.setState({ error: null })
            }}
          >
            返回题库
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
