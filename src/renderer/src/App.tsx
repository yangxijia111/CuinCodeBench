import { Suspense, lazy } from 'react'
import { HashRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { ErrorBoundary } from './components/ErrorBoundary'

/**
 * 应用壳：左侧导航 + 右侧内容区。路由用 HashRouter（file:// 协议兼容）。
 * v1.1 性能：视图按路由懒加载（CodeMirror 仅随练习页加载，显著缩小首屏 bundle）。
 */

const ProblemsView = lazy(() =>
  import('./views/ProblemsView').then((m) => ({ default: m.ProblemsView }))
)
const ProblemEditView = lazy(() =>
  import('./views/ProblemEditView').then((m) => ({ default: m.ProblemEditView }))
)
const PracticeView = lazy(() =>
  import('./views/PracticeView').then((m) => ({ default: m.PracticeView }))
)
const MistakesView = lazy(() =>
  import('./views/MistakesView').then((m) => ({ default: m.MistakesView }))
)
const DashboardView = lazy(() =>
  import('./views/DashboardView').then((m) => ({ default: m.DashboardView }))
)
const SettingsView = lazy(() =>
  import('./views/SettingsView').then((m) => ({ default: m.SettingsView }))
)

function ViewFallback(): React.JSX.Element {
  return (
    <div className="page">
      <div className="empty-hint">加载中…</div>
    </div>
  )
}

export function App(): React.JSX.Element {
  return (
    <HashRouter>
      <div className="app-layout">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <span className="brand-mark">{'</>'}</span>
            <span className="brand-name">CuinCodeBench</span>
          </div>
          <nav className="sidebar-nav" aria-label="主导航">
            <NavLink to="/problems" className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
              题库
            </NavLink>
            <NavLink to="/mistakes" className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
              错题本
            </NavLink>
            <NavLink to="/dashboard" className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
              统计
            </NavLink>
            <NavLink to="/settings" className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
              设置
            </NavLink>
          </nav>
          <div className="sidebar-footer">本地练习 · 数据不出本机</div>
        </aside>
        <main className="content" id="main-content">
          <ErrorBoundary>
            <Suspense fallback={<ViewFallback />}>
              <Routes>
                <Route path="/" element={<Navigate to="/problems" replace />} />
                <Route path="/problems" element={<ProblemsView />} />
                <Route path="/problems/new" element={<ProblemEditView />} />
                <Route path="/problems/:id/edit" element={<ProblemEditView />} />
                <Route path="/practice/:id" element={<PracticeView />} />
                <Route path="/mistakes" element={<MistakesView />} />
                <Route path="/dashboard" element={<DashboardView />} />
                <Route path="/settings" element={<SettingsView />} />
                <Route path="*" element={<div className="page">页面不存在</div>} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </HashRouter>
  )
}
