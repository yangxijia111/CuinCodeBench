import { HashRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { ProblemsView } from './views/ProblemsView'
import { ProblemEditView } from './views/ProblemEditView'
import { PracticeView } from './views/PracticeView'
import { MistakesView } from './views/MistakesView'
import { DashboardView } from './views/DashboardView'
import { SettingsView } from './views/SettingsView'

/**
 * 应用壳：左侧导航 + 右侧内容区。路由用 HashRouter（file:// 协议兼容）。
 */
export function App(): React.JSX.Element {
  return (
    <HashRouter>
      <div className="app-layout">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <span className="brand-mark">{'</>'}</span>
            <span className="brand-name">CuinCodeBench</span>
          </div>
          <nav className="sidebar-nav">
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
        <main className="content">
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
        </main>
      </div>
    </HashRouter>
  )
}
