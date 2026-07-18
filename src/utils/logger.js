/**
 * Logger simples com timestamps
 * Usar isto em vez de console.log para logs consistentes
 */

function timestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

module.exports = {
  info: (message) => console.log(`[${timestamp()}] ℹ️  ${message}`),
  success: (message) => console.log(`[${timestamp()}] ✅ ${message}`),
  warn: (message) => console.log(`[${timestamp()}] ⚠️  ${message}`),
  error: (message) => console.error(`[${timestamp()}] ❌ ${message}`),
  debug: (message) => {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[${timestamp()}] 🐛 ${message}`);
    }
  },
};
