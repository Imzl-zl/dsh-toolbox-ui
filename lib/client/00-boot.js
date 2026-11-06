window.__ModuleLoader__.load({
	id: 'dsh-toolbox-ui',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
// MCP 市场 UI browser bundle：右下角浮动按钮打开响应式管理面板。
var React = require('react');
var __injectCss = function(text) {
  if (typeof document === 'undefined') return () => {};
  var id = 'dsh-toolbox-ui/mcp.css';
  var tag = document.querySelector('style[data-plugin-css="' + id + '"]');
  var created = false;
  if (!tag) {
    tag = document.createElement('style');
    // 两个属性都要盖，与官方构建器 styleInjectionModule 生成的一致
    // （packages/client/tsdown.client.ts）：
    //   data-plugin     模块加载器认领与清理样式的凭据（entry-lifecycle.ts 的
    //                   removeOwnedStyles 只删 data-plugin === 插件 id 的标签）
    //   data-plugin-css 本插件自己的去重键
    // 只盖 pluginCss 时，加载器只能靠「materialize 期间新出现的未打标 style」兜底认领；
    // 若标签在认领窗口之外插入，HMR 卸载就会留下孤儿 style。
    tag.dataset.plugin = 'dsh-toolbox-ui';
    tag.dataset.pluginCss = id;
    document.head.appendChild(tag);
    created = true;
  }
  try {
    tag.textContent = text;
  } catch (error) {
    if (created) tag.remove();
    throw error;
  }
  return () => tag.remove();
};
const React2 = React;
const { useState, useEffect, useCallback, useMemo, useRef } = React2;

