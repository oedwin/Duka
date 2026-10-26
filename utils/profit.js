// utils/profit.js - how profit is worked out, in one place so every screen agrees.
//
//   Money from sales       = completed sales (total after discounts)
//   minus refunds          = money given back for returned items
//   = Sales (net)
//   Cost of goods sold     = what the goods that were sold cost you, minus the cost of goods that came back
//   Gross profit           = Sales (net) - Cost of goods sold
//   Net profit             = Gross profit - Expenses
//
// Returns are counted on the day they happened, not on the day of the original sale.
function profitFigures({ salesTotal, refunds, cogs, returnedCost, expenses }) {
    const net = salesTotal - refunds;
    const cost = cogs - returnedCost;
    const grossProfit = net - cost;
    return { salesNet: net, costOfGoods: cost, grossProfit, netProfit: grossProfit - expenses };
}

module.exports = { profitFigures };
