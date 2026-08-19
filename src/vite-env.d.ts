/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_BACKEND_NORMALIZED_BOOTSTRAP?: string;
  readonly VITE_BACKEND_NORMALIZED_CONFIG_READS?: string;
  readonly VITE_BACKEND_NORMALIZED_CATALOG_READS?: string;
  readonly VITE_BACKEND_NORMALIZED_COMBO_READS?: string;
  readonly VITE_BACKEND_NORMALIZED_LIVE_READS?: string;
  readonly VITE_BACKEND_NORMALIZED_CUSTOMER_SEARCH_READS?: string;
  readonly VITE_BACKEND_NORMALIZED_REPORT_READS?: string;
  readonly VITE_BACKEND_ANALYTICS_SUMMARY_READS?: string;
  readonly VITE_BACKEND_INVENTORY_REPORT_READS?: string;
  readonly VITE_BACKEND_NORMALIZED_BILL_HISTORY_READS?: string;
  readonly VITE_BACKEND_NORMALIZED_REALTIME?: string;
  readonly VITE_BACKEND_RPC_OPERATIONAL_WRITES?: string;
  readonly VITE_BACKEND_RPC_FINANCIAL_WRITES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
