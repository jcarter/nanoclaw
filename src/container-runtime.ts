import { execSync } from 'child_process';

let detectedRuntime: string | null = null;

/**
 * Detect and return the container runtime command ('docker' or 'container').
 * Result is cached after first call.
 */
export function getContainerRuntime(): string {
  if (detectedRuntime) return detectedRuntime;

  // Prefer Docker if available and running
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
    detectedRuntime = 'docker';
    return detectedRuntime;
  } catch {
    // Docker not available or not running
  }

  // Fall back to Apple Container
  try {
    execSync('container --version', { stdio: 'pipe', timeout: 5000 });
    detectedRuntime = 'container';
    return detectedRuntime;
  } catch {
    // Not available either
  }

  throw new Error(
    'No container runtime found. Install Docker or Apple Container.',
  );
}

export function isDocker(): boolean {
  return getContainerRuntime() === 'docker';
}
