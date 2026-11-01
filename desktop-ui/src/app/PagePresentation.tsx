import type { ReactNode } from 'react';
import { Icon } from '../components/icons';
import { Button } from '../components/primitives/inputs';
import { DiagnosticsEntry, FeedbackDeveloperButton } from './StartupDiagnostics';

export const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作暂时无法完成，请稍后重试。';

export function ErrorNotice({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return <div className="harbor-error" role="alert"><Icon name="help" size={17} /><span>{error}</span>{onRetry && <Button compact variant="ghost" onClick={onRetry}>重试</Button>}<DiagnosticsEntry label="诊断"/><FeedbackDeveloperButton/></div>;
}

export function Heading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{description}</p></div>{action && <div className="heading-action">{action}</div>}</div>;
}
