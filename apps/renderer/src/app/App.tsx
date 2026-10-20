import React, { useEffect } from 'react';
import { WorkbenchLayout } from '../layouts/WorkbenchLayout';
import { useAppStore, useRuntimeEventBridge } from '../shared/store';
import { NewTaskWizard } from '../features/new-task/NewTaskWizard';
import { SettingsPage } from '../features/settings/SettingsPage';
import { SkillsCenter } from '../features/skills/SkillsCenter';
import { PreferencesPanel } from '../features/preferences/PreferencesPanel';
import { RemoteLinkPanel } from '../features/remote-link/RemoteLinkPanel';
import { TemplateGallery } from '../features/templates/TemplateGallery';
import { CustomProviderModal } from '../shared/CustomProviderModal';
import { requireApi } from '../shared/ipc';
import type { CustomProvider, ModelId } from '@wdbuddy/shared-types';
import { BUILTIN_MODEL_IDS } from '@wdbuddy/shared-types';
import '../features/task-list/styles.css';
import '../features/chat/styles.css';
import '../features/artifacts/styles.css';
import '../features/new-task/styles.css';
import '../features/settings/styles.css';
import '../features/skills/styles.css';
import '../features/preferences/styles.css';
import '../features/home/styles.css';

export function App(): React.ReactElement {
  // 主题跟随设置（light/dark/auto，§4.7）
  useEffect(() => {
    const applyTheme = (): void => {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const saved = localStorage.getItem('wb-theme');
      const theme = saved === 'auto' || !saved ? (prefersDark ? 'dark' : 'light') : saved;
      document.documentElement.setAttribute('data-theme', theme);
    };
    applyTheme();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', applyTheme);
    return () => mq.removeEventListener('change', applyTheme);
  }, []);

  // runtime 事件桥接（App 根部挂载一次，§10.2）
  useRuntimeEventBridge();

  // 启动时同步模型清单到全局 store（顶栏/首页/向导/设置下拉数据源）：
  // 内置模型可被用户删除，故必须从设置读取"启用中的内置模型"
  useEffect(() => {
    void requireApi()
      .settingsGet()
      .then((s) => {
        useAppStore.getState().setCustomProviders(s.models.customProviders);
        useAppStore
          .getState()
          .setEnabledBuiltin(s.models.enabledBuiltin ?? [...BUILTIN_MODEL_IDS]);
        // 顶栏当前模型若已被删除，回退 Auto，避免新建任务直接报"模型未配置"
        const cur = useAppStore.getState().currentModel;
        const available = new Set<string>([
          'auto',
          ...(s.models.enabledBuiltin ?? BUILTIN_MODEL_IDS),
          ...s.models.customProviders.map((p) => p.id),
        ]);
        if (!available.has(cur)) useAppStore.getState().setCurrentModel('auto');
      })
      .catch(() => undefined);
  }, []);

  const openPanel = useAppStore((s) => s.openPanel);
  const setOpenPanel = useAppStore((s) => s.setOpenPanel);
  const close = (): void => setOpenPanel(null);

  // 自定义 Provider 表单（顶栏“自定义 API…”/设置页共用，全局单例弹窗）
  const customModal = useAppStore((s) => s.customProviderModal);
  const closeCustomModal = (): void => useAppStore.getState().setCustomProviderModal(null);
  const handleCustomSaved = (p: CustomProvider): void => {
    // 顶栏入口保存成功后自动切换到新模型（设置页入口不切换）
    if (customModal?.switchOnSave) useAppStore.getState().setCurrentModel(p.id as ModelId);
  };

  return (
    <>
      <WorkbenchLayout />
      {openPanel === 'new-task' && <NewTaskWizard onClose={close} />}
      {openPanel === 'settings' && <SettingsPage onClose={close} />}
      {openPanel === 'skills' && <SkillsCenter onClose={close} />}
      {openPanel === 'preferences' && <PreferencesPanel onClose={close} />}
      {openPanel === 'remote-link' && <RemoteLinkPanel onClose={close} />}
      {openPanel === 'templates' && <TemplateGallery />}
      {customModal !== null && (
        <CustomProviderModal
          initial={customModal.initial}
          onClose={closeCustomModal}
          onSaved={handleCustomSaved}
        />
      )}
    </>
  );
}
