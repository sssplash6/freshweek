-- Remove every seeded sample row (ids prefixed seed_). Cascades from User,
-- Week, Goal, Meeting, PayrollPeriod etc. take the children with them; the
-- explicit deletes below catch rows whose parents aren't seeded or whose FK
-- is SetNull rather than Cascade.
BEGIN;
DELETE FROM "ColleagueReportSubject" WHERE "reportId" LIKE 'seed_%';
DELETE FROM "PayrollReceipt" WHERE id LIKE 'seed_%';
DELETE FROM "PayrollExpense" WHERE id LIKE 'seed_%';
DELETE FROM "PayrollBonusLine" WHERE id LIKE 'seed_%';
DELETE FROM "PayrollFineLine" WHERE id LIKE 'seed_%';
DELETE FROM "PayrollEvent" WHERE id LIKE 'seed_%';
DELETE FROM "PayrollPdf" WHERE id LIKE 'seed_%';
DELETE FROM "FinePayment" WHERE id LIKE 'seed_%';
DELETE FROM "PayrollSubmission" WHERE id LIKE 'seed_%';
DELETE FROM "PayrollPeriod" WHERE id LIKE 'seed_%';
DELETE FROM "SubtaskShare" WHERE id LIKE 'seed_%';
DELETE FROM "GoalShare" WHERE id LIKE 'seed_%';
DELETE FROM "Subtask" WHERE id LIKE 'seed_%';
DELETE FROM "Goal" WHERE id LIKE 'seed_%';
DELETE FROM "Week" WHERE id LIKE 'seed_%';
DELETE FROM "Month" WHERE id LIKE 'seed_%';
DELETE FROM "DayTask" WHERE id LIKE 'seed_%';
DELETE FROM "DailyReport" WHERE id LIKE 'seed_%';
DELETE FROM "Attendance" WHERE id LIKE 'seed_%';
DELETE FROM "Meeting" WHERE id LIKE 'seed_%';
DELETE FROM "FineWaiver" WHERE id LIKE 'seed_%';
DELETE FROM "Penalty" WHERE id LIKE 'seed_%';
DELETE FROM "Bonus" WHERE id LIKE 'seed_%';
DELETE FROM "AssignedTask" WHERE id LIKE 'seed_%';
DELETE FROM "Notification" WHERE id LIKE 'seed_%';
DELETE FROM "ColleagueReport" WHERE id LIKE 'seed_%';
DELETE FROM "Feedback" WHERE id LIKE 'seed_%';
DELETE FROM "DepartmentMembership" WHERE id LIKE 'seed_%';
DELETE FROM "User" WHERE id LIKE 'seed_%';
DELETE FROM "Department" WHERE id LIKE 'seed_%';
COMMIT;
