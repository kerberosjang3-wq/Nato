const fetch = require('node-fetch');
const iconv = require('iconv-lite');
const q = iconv.encode('삼성전자', 'euc-kr').reduce((str, byte) => str + '%' + byte.toString(16).toUpperCase(), '');
fetch('https://finance.naver.com/search/searchList.naver?query=' + q, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  .then(r => r.arrayBuffer())
  .then(buf => {
    const html = iconv.decode(Buffer.from(buf), 'euc-kr');
    require('fs').writeFileSync('scratch/naver3.html', html);
    const regex = /<a href="\/item\/main\.naver\?code=(\d+)"[^>]*>(.*?)<\/a>/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      console.log(match[1], match[2]);
    }
  })
  .catch(console.error);
