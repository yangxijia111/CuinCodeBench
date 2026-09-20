import { useParams } from 'react-router-dom'

/**
 * 练习页（P4 完整实现：编辑器 + 运行 + 判题结果）。当前为占位。
 */
export function PracticeView(): React.JSX.Element {
  const { id } = useParams()
  return (
    <div className="page">
      <div className="page-header">
        <h2>练习</h2>
      </div>
      <div className="empty-hint">练习页将在 P4 阶段实现（题目 {id ?? ''}）。</div>
    </div>
  )
}
