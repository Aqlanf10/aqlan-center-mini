// Real TypeScript child failure must remain a failing orchestrator result.
enum SyntheticStatus { Failed = 1 }
console.error("Synthetic TypeScript journey failed intentionally");
process.exit(SyntheticStatus.Failed);
