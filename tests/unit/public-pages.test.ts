import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function readRepoFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, `file://${repoRoot}`), 'utf8');
}

describe('GitHub Pages product surface', () => {
  it("uses the Product UI preview as the poster's only product entry point", () => {
    const index = readRepoFile('docs/index.html');
    expect(index).toContain('aria-label="Product preview"');
    expect(index).toContain('PRODUCT UI PREVIEW');
    expect(index).not.toContain('demo.html');
  });

  it('keeps the former demo URL as a compatibility redirect', () => {
    const demo = readRepoFile('docs/demo.html');
    expect(demo).toContain('url=app.html');
    expect(demo).toContain('window.location.replace(target.href)');
    expect(demo).toContain('href="app.html"');
    expect(demo).not.toContain('demo.js');
  });

  it('labels app.html as the single synthetic Product UI surface', () => {
    const app = readRepoFile('docs/app.html');
    expect(app).toContain('<title>SUAS — Product UI preview</title>');
    expect(app).toContain('PRODUCT UI PREVIEW · SYNTHETIC DATA');
    expect(app).toContain('PRODUCT UI · NO API CONNECTION');
    expect(app).toContain('Synthetic data only.');
  });
});
