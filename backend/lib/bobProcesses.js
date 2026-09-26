// lib/bobProcesses.js
// Shared in-memory registry of active Bob child processes, keyed by incidentId.
//
// Task 5 (WebSocket) imports this to listen on the same stream.
// Task 6 (approve)   imports this to check whether the workflow is waiting.
//
// Shape of each entry:
// {
//   proc:       ChildProcess,           // the spawn() handle
//   status:     'running'|'exited',     // updated when the process closes
//   exitCode:   number|null,
//   listeners:  Set<(line: string) => void>  // additional line listeners (WebSocket task)
// }

/** @type {Map<string, {proc: import('child_process').ChildProcess, status: string, exitCode: number|null, listeners: Set<Function>}>} */
const bobProcesses = new Map();

module.exports = bobProcesses;
