const fs = require('fs');
const data = JSON.parse(fs.readFileSync('kr-stocks.json', 'utf8'));
data.forEach((s, i) => {
  if (!s.s || typeof s.s !== 'string') {
    console.log(`Entry ${i} is invalid:`, s);
  }
});
console.log('Validation complete');
