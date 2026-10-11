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
    Devices,
    Connections,
    Security,
    /// 产品化任务 D：版本 / 构建信息 / 更新公告 / 许可证 / 诊断信息。
    About,
    /// 产品化任务 D：全局反馈（含安全漏洞通道与本地待发队列）。
    Feedback,
    /// 产品化任务 D：首次运行引导（完成条件不含 QQ / DSH / 移动端）。
    Onboarding,
    Settings,
}

impl AppPage {
    /// UI v1 一级产品导航（方案 01 的信息层级）：对话永远第一，能力区紧随其后。
    /// 工程面（旧控制台容器 / 设备 / 反馈 / 引导）不在导航里，但从设置与关于可达。
    pub const PRIMARY: [Self; 5] = [Self::Chat, Self::Work, Self::Memory, Self::Agents, Self::Plugins];
    /// UI v1 二级导航：设置与关于（方案 01 的侧栏底部区）。
    pub const SECONDARY: [Self; 2] = [Self::Settings, Self::About];

    /// 侧栏显示名（用户语言）。不在导航里的页面仍需可读名，供设置入口与
    /// 旧控制台 tab 容器使用。
    pub const fn nav_label(self) -> &'static str {
        match self {
            Self::Chat => "对话",
            Self::Work => "工作",
            Self::Memory => "记忆",
            Self::Agents => "智能体",
            Self::Plugins => "插件",
            Self::Settings => "设置",
            Self::About => "关于",
            Self::Home => "状态与日志",
            Self::Social => "渠道控制台",
            Self::Devices => "设备与连接",
            Self::Connections => "服务连接",
            Self::Security => "安全通知",
            Self::Feedback => "反馈",
            Self::Onboarding => "首次引导",
        }
    }

    /// 页面一句话说明：UI v1 页头卡移除后仅供测试与文档使用（保留为页面的权威描述）。
    #[allow(dead_code)]
    pub const fn description(self) -> &'static str {
        match self {
            Self::Chat => "和 CetaMesh 对话；需要时用工具、建任务、交给 Agent。",
            Self::Home => "Core 状态、活动与诊断（旧控制台）。",
            Self::Work => "持久 Task、进度与执行它的 Task Agent Session。",
            Self::Social => "Social 运行策略与连接渠道的互动（旧控制台）。",
            Self::Agents => "DSH / Codex / ZCode 的就绪状态与能力。",
            Self::Plugins => "插件、工具与 MCP 服务器。",
            Self::Memory => "管理 CetaMesh 对话和工作区可使用的记忆。",
            Self::Devices => "设备与 Mesh 连接。",
            Self::Connections => "服务连接与安装状态。",
            Self::Security => "权限与安全通知。",
            Self::About => "版本、Build ID、Commit、更新公告、许可证、隐私与安全说明、诊断信息。",
            Self::Feedback => "反馈与建议 / Bug 反馈 / 功能建议 / 安全漏洞：用系统默认浏览器打开官方网站对应页面。",
            Self::Onboarding => "首次运行引导：配置模型服务商、测试连接、选定默认模型（Agent 与扩展都是可选）。",
            Self::Settings => "通用、外观、模型提供方、设备连接与旧控制台入口。",
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

    /// UI v1：旧控制台 tab 全部归属非导航容器页（Home / Social / Connections / Security），
    /// 产品 Agents 页不再承载工程 tab。
    pub const fn parent_page(self) -> AppPage {
        match self {
            Self::Overview | Self::Activity | Self::Logs | Self::Diagnostics => AppPage::Home,
            Self::Roles | Self::ModelsPresets | Self::Pending => AppPage::Social,
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
            LegacyTab::Roles,
            LegacyTab::ModelsPresets,
            LegacyTab::Pending,
        ],
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
        let primary = AppPage::PRIMARY.map(AppPage::nav_label);
        let secondary = AppPage::SECONDARY.map(AppPage::nav_label);

        assert_eq!(primary, ["对话", "工作", "记忆", "智能体", "插件"]);
        assert_eq!(secondary, ["设置", "关于"]);
    }

    #[test]
    fn nav_labels_are_user_language_and_chat_is_first() {
        assert_eq!(AppPage::PRIMARY[0], AppPage::Chat);
        for page in AppPage::PRIMARY {
            assert!(!page.nav_label().is_empty());
            assert!(!page.description().is_empty());
        }
        // 产品服务页不在导航里，但必须可达且有文案。
        for page in [AppPage::About, AppPage::Feedback, AppPage::Onboarding, AppPage::Devices] {
            assert!(!page.nav_label().is_empty());
            assert!(!page.description().is_empty());
        }
        // 新产品页不是工程页：不能混进 legacy tabs 的归属里。
        assert!(tabs_for(AppPage::About).is_empty());
        assert!(tabs_for(AppPage::Feedback).is_empty());
        assert!(tabs_for(AppPage::Onboarding).is_empty());
        // 产品 Agents 页不再承载旧控制台 tab。
        assert!(tabs_for(AppPage::Agents).is_empty());
        assert!(tabs_for(AppPage::Chat).is_empty());
    }

    #[test]
    fn legacy_tabs_consolidate_into_non_nav_containers() {
        let mut navigation = NavigationState::default();
        assert_eq!(navigation.page, AppPage::Chat);

        navigation.select_legacy_tab(LegacyTab::Services);
        assert_eq!(navigation.page, AppPage::Connections);
        assert_eq!(navigation.legacy_tab, LegacyTab::Services);

        navigation.select_legacy_tab(LegacyTab::Logs);
        assert_eq!(navigation.page, AppPage::Home);
        assert_eq!(navigation.legacy_tab, LegacyTab::Logs);

        // 审批队列（Roles / ModelsPresets / Pending）归入渠道控制台容器，不再占用产品 Agents 页。
        navigation.select_legacy_tab(LegacyTab::Pending);
        assert_eq!(navigation.page, AppPage::Social);
        assert_eq!(navigation.legacy_tab, LegacyTab::Pending);

        navigation.select_legacy_tab(LegacyTab::ModelsPresets);
        assert_eq!(navigation.page, AppPage::Social);
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
        assert_eq!(tabs_for(AppPage::Social).len(), 6);
        assert!(tabs_for(AppPage::Agents).is_empty());
    }
}
