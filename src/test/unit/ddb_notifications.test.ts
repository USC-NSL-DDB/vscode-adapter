import * as assert from "assert";
import { NotificationService } from "../../common/ddb_notification_service";

suite("DDB notifications", () => {
  teardown(() => NotificationService.resetInstance());
  test("welcome is ignored and versioned events reach listeners", () => {
    const service = NotificationService.getInstance();
    const events: unknown[] = [];
    const errors: unknown[] = [];
    service.onNotification("BreakpointChanged", data => events.push(data));
    const originalError = console.error;
    console.error = error => errors.push(error);
    try {
      const receive = (message: unknown) => (service as any).handleMessage(Buffer.from(JSON.stringify(message)));
      receive({type: "welcome", subscriber_id: "test", max_subscribers: 100});
      receive({version: 1, payload: {type: "BreakpointChanged", data: {type: "Removed", data: 7}}});
      assert.deepStrictEqual(events, [{type: "Removed", data: 7}]);
      assert.deepStrictEqual(errors, []);
    } finally { console.error = originalError; }
  });
});
