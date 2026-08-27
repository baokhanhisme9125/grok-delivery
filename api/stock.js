const { getAllStock } = require('../lib/sheets');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const stock = await getAllStock();
    return res.status(200).json({ success: true, stock });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Cannot fetch stock.' });
  }
};
