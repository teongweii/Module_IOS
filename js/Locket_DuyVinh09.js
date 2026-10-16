var obj = JSON.parse($response.body);
obj.Attention = "Chúc mừng bạn! Vui lòng không bán hoặc chia sẻ cho người khác!";

var duyvinh09 = {
      auto_resume_date: null,
      display_name: "locket_1600_1y",
      is_sandbox: true,
      ownership_type: "PURCHASED",
      billing_issues_detected_at: null,
      management_url: "https://apple.com",
      period_type: "normal",
      price: {"amount": 399000.0, "currency": "VND"},
      expires_date: "9999-01-09T10:10:14Z",
      grace_period_expires_date: null,
      refunded_at: null,
      unsubscribe_detected_at: null,
      original_purchase_date: "2007-10-01T10:10:15Z",
      purchase_date: "2007-10-01T10:10:14Z",
      store: "app_store",
      store_transaction_id: "2000001108724193",
  },
  locketGold = {
      grace_period_expires_date: null,
      purchase_date: "2007-10-01T10:10:14Z",
      product_identifier: "Gold",
      expires_date: "9999-01-09T10:10:14Z"
  };

if (obj.subscriber) {
  obj.subscriber.subscriptions["Gold"] = duyvinh09;
  obj.subscriber.subscriptions["locket_1600_1y"] = duyvinh09;
  obj.subscriber.entitlements["Gold"] = locketGold;
}

$done({body: JSON.stringify(obj)});