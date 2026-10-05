//! Product-level navigation for the native CetaMesh Desktop shell.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppPage {
    Home,
    Chat,
    Work,
    Social,
    Agents,
    Plugins,
    Memory,
    Workspaces,
    Devices,
    Connections,
    Security,
    Settings,
}

impl AppPage {
    pub const PRIMARY: [Self; 8] = [Self::Home, Self::Chat, Self::Work, Self::Social,
        Self::Agents, Self::Plugins, Self::Memory, Self::Workspaces];
    pub const SECONDARY: [Self; 4] = [Self::Devices, Self::Connections, Self::Security, Self::Settings];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Home => "Home",
            Self::Chat => "Chat",
            Self::Work => "Work",
            Self::Social => "Social",
            Self::Agents => "Agents",
            Self::Plugins => "Plugins",
            Self::Memory => "Memory",
            Self::Workspaces => "Workspaces",
            Self::Devices => "Devices",
            Self::Connections => "Connections",
            Self::Security => "Security",
            Self::Settings => "Settings",
        }
    }

    pub const fn description(self) -> &'static str {
        match self {
            Self::Chat => "聊天页面已接入产品导航。",
            Self::Home => "Core 状态、活动与诊断。",
            Self::Work => "持久 Task、进度与执行它的 Task Agent Session。",
            Self::Social => "Social 运行策略与连接渠道的互动。",
            Self::Agents => "Agent 角色、模型、Preset 与待处理请求。",
            Self::Plugins => "插件与能力扩展。",
            Self::Memory => "管理 CetaMesh 对话和工作区可使用的记忆。",
            Self::Workspaces => "在明确的安全边界内管理项目和文件。",
            Self::Devices => "设备与 Mesh 连接。",
            Self::Connections => "服务连接与安装状态。",
            Self::Security => "权限与安全通知。",
            Self::Settings => "外观、快捷键与应用偏好。",
        }
    }

}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LegacyTab {
    Overview,
    Roles,
    Policy,
    Services,
    ModelsPresets,
    Pending,
    Security,
    Slang,
    Sessions,
    Activity,
    Logs,
    Diagnostics,
}

impl LegacyTab {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Overview => "Core 状态",
            Self::Roles => "角色",
            Self::Policy => "运行策略",
            Self::Services => "服务连接",
            Self::ModelsPresets => "模型与 Preset",
            Self::Pending => "审批 / 问题",
            Self::Security => "安全通知",
            Self::Slang => "口癖学习",
            Self::Sessions => "渠道会话",
            Self::Activity => "活动记录",
            Self::Logs => "日志",
            Self::Diagnostics => "诊断",
        }
    }

    pub const fn parent_page(self) -> AppPage {
        match self {
            Self::Overview | Self::Activity | Self::Logs | Self::Diagnostics => AppPage::Home,
            Self::Roles | Self::ModelsPresets | Self::Pending => AppPage::Agents,
            Self::Policy | Self::Slang | Self::Sessions => AppPage::Social,
            Self::Services => AppPage::Connections,
            Self::Security => AppPage::Security,
        }
    }
}

pub const fn tabs_for(page: AppPage) -> &'static [LegacyTab] {
    match page {
        AppPage::Home => &[
            LegacyTab::Overview,
            LegacyTab::Diagnostics,
            LegacyTab::Activity,
            LegacyTab::Logs,
        ],
        AppPage::Social => &[
            LegacyTab::Policy,
            LegacyTab::Slang,
            LegacyTab::Sessions,
        ],
        AppPage::Agents => &[LegacyTab::Roles, LegacyTab::ModelsPresets, LegacyTab::Pending],
        AppPage::Connections => &[LegacyTab::Services],
        AppPage::Security => &[LegacyTab::Security],
        _ => &[],
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NavigationState {
    pub page: AppPage,
    pub legacy_tab: LegacyTab,
}

impl Default for NavigationState {
    fn default() -> Self {
        Self {
            page: AppPage::Chat,
            legacy_tab: LegacyTab::Overview,
        }
    }
}

impl NavigationState {
    pub fn select_page(&mut self, page: AppPage) {
        self.page = page;
        let tabs = tabs_for(page);
        if !tabs.is_empty() && !tabs.contains(&self.legacy_tab) {
            self.legacy_tab = tabs[0];
        }
    }

    pub fn select_legacy_tab(&mut self, tab: LegacyTab) {
        self.legacy_tab = tab;
        self.page = tab.parent_page();
    }
}

#[cfg(test)]
mod tests {
    use super::{AppPage, LegacyTab, NavigationState, tabs_for};

    #[test]
    fn product_shell_has_the_required_primary_and_secondary_navigation() {
        let primary = AppPage::PRIMARY.map(AppPage::label);
        let secondary = AppPage::SECONDARY.map(AppPage::label);

        assert_eq!(primary, ["Home", "Chat", "Work", "Social", "Agents", "Plugins", "Memory", "Workspaces"]);
        assert_eq!(secondary, ["Devices", "Connections", "Security", "Settings"]);
    }

    #[test]
    fn navigation_starts_in_chat_and_routes_legacy_pages_into_secondary_areas() {
        let mut navigation = NavigationState::default();
        assert_eq!(navigation.page, AppPage::Chat);

        navigation.select_legacy_tab(LegacyTab::Services);
        assert_eq!(navigation.page, AppPage::Connections);
        assert_eq!(navigation.legacy_tab, LegacyTab::Services);

        navigation.select_legacy_tab(LegacyTab::Logs);
        assert_eq!(navigation.page, AppPage::Home);
        assert_eq!(navigation.legacy_tab, LegacyTab::Logs);

        navigation.select_legacy_tab(LegacyTab::Pending);
        assert_eq!(navigation.page, AppPage::Agents);
        assert_eq!(navigation.legacy_tab, LegacyTab::Pending);
    }

    #[test]
    fn selecting_a_secondary_page_keeps_its_current_tab_or_chooses_its_first_tab() {
        let mut navigation = NavigationState::default();
        navigation.select_page(AppPage::Home);
        assert_eq!(navigation.legacy_tab, LegacyTab::Overview);

        navigation.select_page(AppPage::Social);
        assert_eq!(navigation.legacy_tab, LegacyTab::Policy);
        navigation.select_legacy_tab(LegacyTab::Activity);
        navigation.select_page(AppPage::Home);
        assert_eq!(navigation.legacy_tab, LegacyTab::Activity);

        assert_eq!(tabs_for(AppPage::Home).len(), 4);
        assert_eq!(tabs_for(AppPage::Social).len(), 3);
        assert_eq!(tabs_for(AppPage::Agents).len(), 3);
        assert!(tabs_for(AppPage::Chat).is_empty());
    }
}
