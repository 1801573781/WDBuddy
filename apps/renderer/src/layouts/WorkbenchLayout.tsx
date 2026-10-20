/**
 * WorkbenchLayout — WorkBuddy 式工作台骨架
 * 自定义标题栏（菜单+窗口控制）/ 左栏（导航+任务+空间+用户栏）/ 主区（首页或任务对话）/ 右栏（任务态成果区）
 * feature（task-list / chat / artifacts）之间禁止互相 import，事件经 shared/store 桥接。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BUILTIN_MODEL_NAMES } from '@wdbuddy/shared-types';
import { useAppStore, useVisibleModels } from '../shared/store';
import { getApi } from '../shared/ipc';
import { TaskSidebar } from '../features/task-list/TaskSidebar';
import { HomeView } from '../features/home/HomeView';
import { ChatPanel } from '../features/chat/ChatPanel';
import { ArtifactPanel } from '../features/artifacts/ArtifactPanel';

export function WorkbenchLayout(): React.ReactElement {
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const artifactsHidden = useAppStore((s) => s.artifactsHidden);
  const artifactWidth = useAppStore((s) => s.artifactWidth);
  const runtimeState = useAppStore((s) => s.runtimeState);
  const currentModel = useAppStore((s) => s.currentModel);
  const tokenCount = useAppStore((s) => s.tokenCount);
  const credits = useAppStore((s) => s.credits);
  const toggleArtifacts = useAppStore((s) => s.toggleArtifacts);
  const setArtifactWidth = useAppStore((s) => s.setArtifactWidth);

  // 右栏拖拽调宽（320~640，仅任务态出现）
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      dragRef.current = { startX: e.clientX, startWidth: artifactWidth };
      const onMove = (ev: MouseEvent): void => {
        if (!dragRef.current) return;
        const delta = dragRef.current.startX - ev.clientX;
        const next = Math.min(640, Math.max(320, dragRef.current.startWidth + delta));
        setArtifactWidth(next);
      };
      const onUp = (): void => {
        dragRef.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [artifactWidth, setArtifactWidth]
  );

  const showArtifacts = !artifactsHidden && activeTaskId !== null;

  const cls = ['wb-workbench', showArtifacts ? '' : 'wb-workbench--artifacts-hidden']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} style={{ gridTemplateColumns: `var(--wb-sidebar-width) 1fr ${showArtifacts ? artifactWidth + 'px' : '0'}` }}>
      {/* ────────── 自定义标题栏：品牌 + 菜单 + 模型 + 窗口控制 ────────── */}
      <TitleBar currentModel={currentModel} />

      {/* ────────── 左栏：导航 + 任务 + 空间 + 用户栏 ────────── */}
      <aside className="wb-sidebar">
        <TaskSidebar />
      </aside>

      {/* ────────── 主区：首页（无选中任务）或 任务对话 ────────── */}
      <main className="wb-chat">
        {activeTaskId ? <ChatPanel /> : <HomeView />}
      </main>

      {/* ────────── 右栏：成果区（任务态） ────────── */}
      {showArtifacts && (
        <>
          <div
            className="wb-artifacts__resizer"
            onMouseDown={onDragStart}
            style={{ cursor: 'col-resize', width: 4, background: 'var(--wb-border)' }}
            role="separator"
            aria-orientation="vertical"
          />
          <section className="wb-artifacts">
            <ArtifactPanel />
          </section>
        </>
      )}

      {/* ────────── 状态栏 ────────── */}
      <footer className="wb-statusbar">
        <span className={`wb-dot ${runtimeState === 'running' ? '' : runtimeState === 'offline' ? 'wb-dot--offline' : 'wb-dot--busy'}`} />
        <span>
          {runtimeState === 'running' ? 'Agent 运行中' : runtimeState === 'offline' ? 'Runtime 离线（降级）' : '空闲'}
        </span>
        <span>· {modelDisplayName(currentModel)}</span>
        <span>· 本任务 Token {(tokenCount / 1000).toFixed(1)}k</span>
        <span>· 积分 {credits}</span>
        <button
          className="wb-btn wb-btn--ghost wb-btn--small"
          onClick={() => toggleArtifacts()}
          title={artifactsHidden ? '显示成果区' : '隐藏成果区'}
        >
          {artifactsHidden ? '显示成果区' : '隐藏成果区'}
        </button>
        <span className="wb-statusbar__version">v1.0.0</span>
      </footer>
    </div>
  );
}

/** 模型显示名（状态栏） */
function modelDisplayName(id: string): string {
  if (id === 'auto') return 'Auto 路由';
  return BUILTIN_MODEL_NAMES[id] ?? id;
}

/** 自定义标题栏：WorkBuddy 式菜单（编辑/窗口/帮助）+ 模型下拉 + 窗口控制 */
function TitleBar({ currentModel }: { currentModel: string }): React.ReactElement {
  const setOpenPanel = useAppStore((s) => s.setOpenPanel);
  // 只展示"启用中的内置模型 + 自定义 Provider"，内置模型可被用户删除
  const models = useVisibleModels();
  const maxMode = useAppStore((s) => s.maxMode);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 点击别处关闭菜单
  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, []);

  const api = getApi();

  const onModelChange = (value: string): void => {
    if (value === 'custom:api') {
      useAppStore.getState().setCustomProviderModal({ initial: null, switchOnSave: true });
      return;
    }
    useAppStore.getState().setCurrentModel(value as never);
  };

  const menuDef: Array<{ key: string; label: string; items: Array<{ label: string; onClick?: () => void; hint?: string; disabled?: boolean }> }> = [
    {
      key: 'edit',
      label: '编辑(E)',
      items: [
        { label: '新建任务', onClick: () => setOpenPanel('new-task'), hint: 'Ctrl+N' },
        { label: '提示词增强设置', onClick: () => setOpenPanel('settings') },
        { label: '偏好设置', onClick: () => setOpenPanel('preferences') },
      ],
    },
    {
      key: 'window',
      label: '窗口(W)',
      items: [
        { label: '最小化', onClick: () => void api?.winMinimize() },
        {
          label: maximized ? '还原' : '最大化',
          onClick: () => {
            void api?.winToggleMaximize().then((r) => setMaximized(r.maximized));
          },
        },
        { label: '隐藏成果区', onClick: () => useAppStore.getState().toggleArtifacts() },
        { label: '关闭', onClick: () => void api?.winClose() },
      ],
    },
    {
      key: 'help',
      label: '帮助(H)',
      items: [
        { label: '模板库', onClick: () => setOpenPanel('templates') },
        { label: '技能中心', onClick: () => setOpenPanel('skills') },
        { label: '设置', onClick: () => setOpenPanel('settings') },
        { label: '关于 WDBuddy', disabled: true },
      ],
    },
  ];

  return (
    <header className="wb-titlebar" ref={menuRef}>
      <div className="wb-titlebar__logo">
        <span className="wb-titlebar__logo-icon">W</span> WDBuddy
      </div>
      {menuDef.map((m) => (
        <div className="wb-titlebar__menu" key={m.key}>
          <button
            className={`wb-titlebar__menu-btn ${openMenu === m.key ? 'wb-titlebar__menu-btn--open' : ''}`}
            onClick={() => setOpenMenu(openMenu === m.key ? null : m.key)}
          >
            {m.label}
          </button>
          {openMenu === m.key && (
            <div className="wb-titlebar__menu-list">
              {m.items.map((it) => (
                <button
                  key={it.label}
                  className={`wb-titlebar__menu-item ${it.disabled ? 'wb-titlebar__menu-item--disabled' : ''}`}
                  onClick={() => {
                    setOpenMenu(null);
                    it.onClick?.();
                  }}
                >
                  {it.label}
                  {it.hint && <span className="wb-titlebar__menu-hint">{it.hint}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      <div className="wb-titlebar__spacer" />
      <div className="wb-titlebar__actions">
        <select
          className="wb-select wb-titlebar__model"
          value={currentModel}
          onChange={(e) => onModelChange(e.target.value)}
          aria-label="模型选择"
          title="模型选择"
        >
          <option value="auto">Auto（自动选择）</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
          {currentModel !== 'auto' &&
            !models.some((m) => m.id === currentModel) && (
              <option value={currentModel}>{modelDisplayName(currentModel)}（不可用）</option>
            )}
          <option value="custom:api">＋ 添加自定义模型…</option>
        </select>
        {maxMode && (
          <span className="wb-badge wb-badge--info" title="增强上下文已开启：长文档/代码类任务自动使用更大上下文窗口模型">
            Max
          </span>
        )}
        <button className="wb-btn wb-btn--ghost wb-btn--small" onClick={() => setOpenPanel('templates')} title="模板库">
          模板库
        </button>
        <button className="wb-btn wb-btn--ghost wb-btn--small" onClick={() => setOpenPanel('settings')} title="设置">
          设置
        </button>
      </div>
      <div className="wb-titlebar__win">
        <button className="wb-titlebar__win-btn" title="最小化" onClick={() => void api?.winMinimize()}>
          ─
        </button>
        <button
          className="wb-titlebar__win-btn"
          title={maximized ? '还原' : '最大化'}
          onClick={() => void api?.winToggleMaximize().then((r) => setMaximized(r.maximized))}
        >
          ▢
        </button>
        <button className="wb-titlebar__win-btn wb-titlebar__win-btn--close" title="关闭" onClick={() => void api?.winClose()}>
          ✕
        </button>
      </div>
    </header>
  );
}
