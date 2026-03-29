const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';

function timestamp(): string {
  return DIM + new Date().toISOString().slice(11, 19) + RESET;
}

export function info(msg: string): void {
  console.log(`${timestamp()} ${msg}`);
}

export function success(msg: string): void {
  console.log(`${timestamp()} ${GREEN}✓${RESET} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${timestamp()} ${YELLOW}⚠${RESET} ${msg}`);
}

export function error(msg: string): void {
  console.error(`${timestamp()} ${RED}✗${RESET} ${msg}`);
}

export function step(msg: string): void {
  console.log(`${timestamp()} ${CYAN}→${RESET} ${msg}`);
}

export function heading(msg: string): void {
  console.log(`\n${BOLD}${msg}${RESET}`);
}

export function dim(msg: string): void {
  console.log(`${DIM}  ${msg}${RESET}`);
}
