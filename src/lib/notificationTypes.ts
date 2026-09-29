// Client-safe mirror of the Prisma `NotificationType` enum, so components can
// type notification views without importing the generated server client.
// (Same pattern as lib/penalties.ts mirroring PenaltyType.)

export type NotificationType =
  | "FINE"
  | "BONUS"
  | "TASK_ASSIGNED"
  | "REPORT"
  | "PAYROLL"
  | "MARKETING"
  | "OTHER";

// Dot color per type, shared by the bell dropdown and the notifications page:
// red fine, green bonus, amber task (matches the "Assigned to you" card),
// navy report, orange payroll (money moving = progress, per the palette),
// amber marketing too — a shoot on the calendar or a task handed over is
// work landing on your desk, the same family as an assigned task.
export const NOTIFICATION_DOT: Record<NotificationType, string> = {
  FINE: "bg-red-500",
  BONUS: "bg-green-500",
  TASK_ASSIGNED: "bg-amber-500",
  REPORT: "bg-brand",
  PAYROLL: "bg-accent",
  MARKETING: "bg-amber-500",
  OTHER: "bg-line",
};
