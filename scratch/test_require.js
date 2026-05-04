try {
  const app = require('../server');
  console.log('Successfully required server.js');
} catch (e) {
  console.error('Failed to require server.js:', e);
}
