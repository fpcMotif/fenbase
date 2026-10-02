import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConvexBetterAuthProvider } from '@convex-dev/better-auth/react';
import { ConvexReactClient } from 'convex/react';
import { Alert, App as AntdApp, Card, ConfigProvider, Spin, Typography } from 'antd';
import type { ReactNode } from 'react';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';
import { useTranslation } from 'react-i18next';
import { authClient } from '../lib/auth/client';
import DemoApp from './App';
import './i18n';
import './styles.css';

function MissingConfiguration() {
  const { t } = useTranslation();

  return (
    <main className="demo-page demo-centered">
      <Card className="demo-config-card">
        <Typography.Title level={3}>{t('config.title')}</Typography.Title>
        <Alert showIcon type="warning" message={t('config.description')} />
      </Card>
    </main>
  );
}

// Follows the app language so antd's own texts, such as the pagination size picker, are translated too.
function LocalizedConfigProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  return <ConfigProvider locale={i18n.language === 'zh-CN' ? zhCN : enUS}>{children}</ConfigProvider>;
}

const convexUrl = import.meta.env.VITE_CONVEX_URL;
const convexSiteUrl = import.meta.env.VITE_CONVEX_SITE_URL;
const root = ReactDOM.createRoot(document.getElementById('root')!);

if (!convexUrl || !convexSiteUrl) {
  root.render(
    <React.StrictMode>
      <LocalizedConfigProvider>
        <AntdApp>
          <MissingConfiguration />
        </AntdApp>
      </LocalizedConfigProvider>
    </React.StrictMode>,
  );
} else {
  const convex = new ConvexReactClient(convexUrl, { expectAuth: true });

  root.render(
    <React.StrictMode>
      <LocalizedConfigProvider>
        <AntdApp>
          <ConvexBetterAuthProvider client={convex} authClient={authClient}>
            <DemoApp />
          </ConvexBetterAuthProvider>
        </AntdApp>
      </LocalizedConfigProvider>
    </React.StrictMode>,
  );
}
