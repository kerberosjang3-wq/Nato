const fetch = require('node-fetch');
fetch('https://finance.naver.com/search/searchList.naver?query=' + encodeURIComponent('삼성전자'))
  .then(r => r.text())
  .then(html => {
    const fs = require('fs');
    fs.writeFileSync('scratch/naver.html', html);
    const regex = /<a href="\/item\/main\.naver\?code=(\d+)"[^>]*>(.*?)<\/a>/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      console.log(match[1], match[2]);
    }
  })
  .catch(console.error);
