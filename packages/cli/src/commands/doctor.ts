import { gitx } from '../context.js';

export const command = 'doctor';
export const describe = 'Check Git and shared store configuration';
export const handler = async () => {
  const result = await gitx().doctor();
  for (const check of result.checks) {
    console.log(`${check.ok ? 'OK' : 'WARN'} ${check.name}: ${check.detail}`);
  }
  if (result.checks.some((check) => !check.ok)) process.exitCode = 1;
};
