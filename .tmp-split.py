import subprocess

p = "src/lib/upload-memory.ts"
current = open(p).read()
open(".tmp-f1f2.ts", "w").write(current)

old_file = subprocess.check_output(
    ["git", "show", "b0a4b6c:src/lib/upload-memory.ts"], text=True
)

marker_start = "/**\n * Shortest interval between shed log lines; the rest are counted and reported"
marker_end = "/** One line describing the budget, and where each number came from. */"

old_block = old_file[old_file.index(marker_start) : old_file.index(marker_end)]
new_block = current[current.index(marker_start) : current.index(marker_end)]

# finding-1-only = current, with the logger reverted to its committed form
f1_only = current.replace(new_block, old_block, 1)
assert f1_only != current
# stats() flush + reset timer belong to finding 2 as well
f1_only = f1_only.replace(
    """export function uploadMemoryStats() {
  // Anyone asking how the budget is doing should not be told a shed count
  // that is still sitting unprinted in the throttle; see flushShedLog.
  flushShedLog();
  return {""",
    """export function uploadMemoryStats() {
  return {""",
)
f1_only = f1_only.replace(
    """  shedLogLastAt = 0;
  shedLogSuppressed = 0;
  if (shedLogFlushTimer) {
    clearTimeout(shedLogFlushTimer);
    shedLogFlushTimer = undefined;
  }
}""",
    """  shedLogLastAt = 0;
  shedLogSuppressed = 0;
}""",
)
open(p, "w").write(f1_only)
print("split ok")
