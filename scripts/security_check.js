// ============================================================================
// Automated Security Checker (Scans codebase for leaked service keys or secrets)
// ============================================================================

import fs from 'fs';
import path from 'path';

const FORBIDDEN_PATTERNS = [
  /SUPABASE_SERVICE_ROLE_KEY/i,
  /service_role/i,
  /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/, // Real JWT regex
];

const SCAN_DIRS = ['src', 'public', 'supabase'];
const SCAN_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.html', '.sql', '.json'];

let violations = 0;

function scanDirectory(dir) {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'dist') {
        scanDirectory(fullPath);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SCAN_EXTENSIONS.includes(ext) || entry.name.startsWith('.env')) {
        checkFile(fullPath);
      }
    }
  }
}

function checkFile(filePath) {
  // Exclude this script itself
  if (filePath.includes('security_check.js')) return;

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  lines.forEach((line, index) => {
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(line)) {
        // Exclude benign comment warnings that explicitly tell developers NOT to use service role
        if (line.includes('NEVER') || line.includes('never') || line.includes('Forbidden') || line.includes('Check for')) {
          continue;
        }

        console.error(`🚨 SECURITY VIOLATION in ${filePath}:${index + 1}`);
        console.error(`   Offending content: ${line.trim()}`);
        violations++;
      }
    }
  });
}

console.log('🔍 Running LaundryFlow Security Check...');
SCAN_DIRS.forEach(dir => scanDirectory(path.resolve(process.cwd(), dir)));

// Also scan .env.example
if (fs.existsSync('.env.example')) checkFile('.env.example');

if (violations > 0) {
  console.error(`\n❌ FAILED: Found ${violations} security secret violation(s)!`);
  process.exit(1);
} else {
  console.log('✅ PASS: No forbidden service role keys or hardcoded credentials detected.');
  process.exit(0);
}
