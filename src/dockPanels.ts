import { Actions, BorderNode, DockLocation, Model, TabGroupNode, TabNode, TabSetNode, type IJsonBorderNode, type IJsonTabNode } from 'flexlayout-react';

export const panelTabs = {
  explorer: { type: 'tab', id: 'explorer', name: 'Explorer', component: 'explorer', enableClose: false },
  search: { type: 'tab', id: 'search', name: 'Search', component: 'search', enableClose: false },
  git: { type: 'tab', id: 'git', name: 'Git', component: 'git', enableClose: false },
  problems: { type: 'tab', id: 'problems', name: 'Problems', component: 'problems', enableClose: false },
} as const satisfies Record<string, IJsonTabNode>;
export type PanelId = keyof typeof panelTabs;
export const navigationPanelIds = ['explorer', 'search', 'git'] as const;
export const panelIds = [...navigationPanelIds, 'problems'] as const;

// Moving tabs here hides their UI without unmounting their contents or closing running shells.
export const hiddenPanelsBorder = (): IJsonBorderNode => ({ type: 'border', location: 'left', show: false, enableDrop: false, children: [] });

export function tabsetOf(tab?: TabNode): TabSetNode | undefined {
  const parent = tab?.getParent();
  const group = parent instanceof TabGroupNode ? parent.getParent() : parent;
  return group instanceof TabSetNode ? group : undefined;
}

export function getTab(model: Model, id: string): TabNode | undefined {
  const node = model.getNodeById(id);
  return node instanceof TabNode ? node : undefined;
}

function namedGroup(model: Model, id: string) {
  const node = model.getNodeById(id);
  return node instanceof TabSetNode ? node : undefined;
}

export const documentTabset = (model: Model) => namedGroup(model, 'documents') ?? tabsetOf(getTab(model, 'welcome'));

export function terminalTabs(model: Model) {
  const tabs: TabNode[] = [];
  model.visitNodes(node => { if (node instanceof TabNode && node.getComponent() === 'terminal') tabs.push(node); });
  return tabs;
}

export function terminalTabset(model: Model) {
  return namedGroup(model, 'terminals') ?? tabsetOf(getTab(model, 'problems')) ?? terminalTabs(model).map(tabsetOf).find(Boolean);
}

export function restorePanelSizes(model: Model) {
  const maximized = model.getMaximizedTabset();
  if (maximized) model.doAction(Actions.maximizeToggle(maximized.getId()));
}

export function isPanelShown(model: Model, tab?: TabNode) {
  const group = tabsetOf(tab);
  const maximized = model.getMaximizedTabset();
  return !!group && (!maximized || group === maximized);
}

export function revealTab(model: Model, tab: TabNode) {
  if (!isPanelShown(model, tab)) restorePanelSizes(model);
  model.doAction(Actions.selectTab(tab.getId()));
}

export function hidePanels(model: Model, tabs: TabNode[], sidebar = false) {
  const border = model.getNodeById('border_left');
  if (!(border instanceof BorderNode) || border.isShowing()) return;
  const actions = tabs.flatMap(tab => {
    const group = tabsetOf(tab);
    if (!group) return [];
    const config = { ...tab.getConfig(), leveDock: {
      group: group.getId(), index: group.getChildren().indexOf(tab), sidebar, selected: tab.isSelected(),
    } };
    return [Actions.updateNodeAttributes(tab.getId(), { config }), Actions.moveNode(tab.getId(), border.getId(), DockLocation.CENTER, -1, false)];
  });
  if (actions.length) model.doAction(Actions.group(actions));
}

export function dockPanel(model: Model, tab: TabNode | IJsonTabNode, select = true) {
  const existing = tab instanceof TabNode ? tab : undefined;
  if (tabsetOf(existing)) {
    if (select && existing) revealTab(model, existing);
    return;
  }
  const component = tab instanceof TabNode ? tab.getComponent() : tab.component;
  const previous = existing?.getConfig()?.leveDock;
  const original = typeof previous?.group === 'string' ? namedGroup(model, previous.group) : undefined;
  const bottom = component === 'terminal' || component === 'problems';
  const home = bottom ? terminalTabset(model) : namedGroup(model, 'navigation') ?? navigationPanelIds.map(id => tabsetOf(getTab(model, id))).find(Boolean);
  const group = original ?? home;
  const target = group ?? (bottom ? documentTabset(model) : model.getRootRow());
  if (!target) return;
  if (select && (!group || (model.getMaximizedTabset() && model.getMaximizedTabset() !== group))) restorePanelSizes(model);
  const location = group ? DockLocation.CENTER : bottom ? DockLocation.BOTTOM : DockLocation.LEFT;
  const index = original && Number.isInteger(previous.index) && previous.index >= 0 ? Math.min(previous.index, original.getChildren().length) : -1;
  if (tab instanceof TabNode) {
    if (tab.getParent() instanceof BorderNode) model.doAction(Actions.moveNode(tab.getId(), target.getId(), location, index, select));
  } else model.doAction(Actions.addNode(tab, target.getId(), location, index, select));
}
