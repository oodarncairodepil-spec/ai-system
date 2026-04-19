const axios = require('axios');

// example: product API
async function fetchProducts() {
  const res = await axios.get('https://faas.plugo.world/partner/v1/products', {
    headers: {
      partnerID: 'partner-api-test',
      partnerPASS: 'qbNKbJPpKJlAdECGIcck',
      vendorID: '3476',
      signedKey: 'REPLACE_THIS_LATER',
      timeStamp: new Date().toISOString(),
    },
  });

  return res.data;
}

// example: shipping pricing API (your Rayspeed)
async function getShippingPrice(data) {
  const res = await axios.post(
    'https://rayspeed.com/speedship/sandbox/pricing.php',
    data
  );

  return res.data;
}

module.exports = {
  fetchProducts,
  getShippingPrice,
};
