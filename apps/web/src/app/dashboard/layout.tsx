import { ConsoleScope } from "./console-scope";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleScope>{children}</ConsoleScope>;
}
