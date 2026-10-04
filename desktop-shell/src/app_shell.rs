//! Product-level navigation for the native CetaMesh Desktop shell.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppPage {
    Chat,
    Tasks,
    Memory,
    Workspace,
    Settings,
    Diagnostics,
    Advanced,
}

impl AppPage {
    pub const PRIMARY: [Self; 4] = [Self::Chat, Self::Tasks, Self::Memory, Self::Workspace];
    pub const SECONDARY: [Self; 3] = [Self::Settings, Self::Diagnostics, Self::Advanced];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Chat => "Chat",
            Self::Tasks => "Tasks",
            Self::Memory => "Memory",
            Self::Workspace => "Workspace",
            Self::Settings => "Settings",
            Self::Diagnostics => "Diagnostics",
            Self::Advanced => "Advanced",
        }
    }

    pub const fn description(self) -> &'static str {
        match self {
            Self::Chat => "聊天页面已接入产品导航。",
            Self::Tasks => "由 CetaMesh 持有的目标与进度，独立于 Agent 会话。",
            Self::Memory => "管理 CetaMesh 对话和工作区可使用的记忆。",
            Self::Workspace => "在明确的安全边界内管理项目和文件。",
            Self::Settings => "Core 运行时、本地服务、模型与安全通知。",
            Self::Diagnostics => "运行诊断、活动记录和本地日志。",
            Self::Advanced => "角色、策略、审批、会话与语言配置。",
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
            Self::Overview => "核心运行时",
            Self::Roles => "角色",
            Self::Policy => "运行策略",
            Self::Services => "本地服务",
            Self::ModelsPresets => "模型与 Preset",
            Self::Pending => "审批 / 问题",
            Self::Security => "安全通知",
            Self::Slang => "口癖学习",
            Self::Sessions => "会话",
            Self::Activity => "活动记录",
            Self::Logs => "日志",
            Self::Diagnostics => "诊断",
        }
    }

    pub const fn parent_page(self) -> AppPage {
        match self {
            Self::Overview | Self::Services | Self::ModelsPresets | Self::Security => {
                AppPage::Settings
            }
            Self::Activity | Self::Logs | Self::Diagnostics => AppPage::Diagnostics,
            Self::Roles | Self::Policy | Self::Pending | Self::Slang | Self::Sessions => {
                AppPage::Advanced
            }
        }
    }
}

pub const fn tabs_for(page: AppPage) -> &'static [LegacyTab] {
    match page {
        AppPage::Settings => &[
            LegacyTab::Overview,
            LegacyTab::Services,
            LegacyTab::ModelsPresets,
            LegacyTab::Security,
        ],
        AppPage::Diagnostics => &[
            LegacyTab::Diagnostics,
            LegacyTab::Activity,
            LegacyTab::Logs,
        ],
        AppPage::Advanced => &[
            LegacyTab::Roles,
            LegacyTab::Policy,
            LegacyTab::Pending,
            LegacyTab::Slang,
            LegacyTab::Sessions,
        ],
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

        assert_eq!(primary, ["Chat", "Tasks", "Memory", "Workspace"]);
        assert_eq!(secondary, ["Settings", "Diagnostics", "Advanced"]);
    }

    #[test]
    fn navigation_starts_in_chat_and_routes_legacy_pages_into_secondary_areas() {
        let mut navigation = NavigationState::default();
        assert_eq!(navigation.page, AppPage::Chat);

        navigation.select_legacy_tab(LegacyTab::Services);
        assert_eq!(navigation.page, AppPage::Settings);
        assert_eq!(navigation.legacy_tab, LegacyTab::Services);

        navigation.select_legacy_tab(LegacyTab::Logs);
        assert_eq!(navigation.page, AppPage::Diagnostics);
        assert_eq!(navigation.legacy_tab, LegacyTab::Logs);

        navigation.select_legacy_tab(LegacyTab::Pending);
        assert_eq!(navigation.page, AppPage::Advanced);
        assert_eq!(navigation.legacy_tab, LegacyTab::Pending);
    }

    #[test]
    fn selecting_a_secondary_page_keeps_its_current_tab_or_chooses_its_first_tab() {
        let mut navigation = NavigationState::default();
        navigation.select_page(AppPage::Settings);
        assert_eq!(navigation.legacy_tab, LegacyTab::Overview);

        navigation.select_page(AppPage::Diagnostics);
        assert_eq!(navigation.legacy_tab, LegacyTab::Diagnostics);
        navigation.select_legacy_tab(LegacyTab::Activity);
        navigation.select_page(AppPage::Diagnostics);
        assert_eq!(navigation.legacy_tab, LegacyTab::Activity);

        assert_eq!(tabs_for(AppPage::Settings).len(), 4);
        assert_eq!(tabs_for(AppPage::Diagnostics).len(), 3);
        assert_eq!(tabs_for(AppPage::Advanced).len(), 5);
        assert!(tabs_for(AppPage::Chat).is_empty());
    }
}
