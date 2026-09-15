import * as assert from "assert";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import { MI2 } from "../../backend/mi2/mi2";
import { configureServiceUrl, getServiceUrl, getWebSocketUrl, selectThread } from "../../common/ddb_api";

suite("DDB lifecycle", function () {
  this.timeout(10000);
  let server: http.Server;
  let previousUrl: string;
  setup(async () => {
    previousUrl = getServiceUrl();
    server = http.createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({status: "up"}));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    configureServiceUrl(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  });
  teardown(async () => {
    configureServiceUrl(previousUrl);
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  test("service URLs share a normalized base", () => {
    assert.ok(!getServiceUrl().endsWith("/"));
    assert.strictEqual(getWebSocketUrl(), getServiceUrl().replace(/^http/, "ws") + "/notifications/subscribe");
  });

  test("spawn errors reject launch promptly", async () => {
    const mi = new MI2("/does-not-exist/ddb", [], [], undefined);
    await assert.rejects(Promise.resolve(mi.load("", "", "", "", [])), /ENOENT/);
  });

  test("launch forwards cwd and environment, runs autorun, and rejects pending commands on exit", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ddb-launch-test-"));
    const script = `
      require('readline').createInterface({input: process.stdin}).on('line', line => {
        const token = line.match(/^\\d+/)?.[0];
        if (line.includes('exit-test')) process.exit(0);
        else console.log(token + '^done,value=' + JSON.stringify(process.cwd() + '|' + process.env.DDB_TEST_ENV));
      });`;
    const mi = new MI2(process.execPath, ["-e", script], [], {DDB_TEST_ENV: "forwarded"});
    try {
      await mi.load(cwd, "", "", "", ["-environment-test"]);
      const response = await mi.sendCommand("environment-test");
      assert.strictEqual(response.result("value"), `${cwd}|forwarded`);
      await assert.rejects(Promise.resolve(mi.sendCommand("exit-test")), /DDB exited/);
      await mi.stop();
      await assert.rejects(Promise.resolve(mi.sendCommand("after-exit")), /not running/);
    } finally { await mi.stop(); fs.rmSync(cwd, {recursive: true, force: true}); }
  });

  test("HTTP thread selection validates backend completion errors", async () => {
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      assert.strictEqual(req.url, "/api/v1/threads/select");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({api_version: "1", data: {state: "completed", result: {responses: [{status: "error", payload: {msg: "No such thread"}}]}}}));
    });
    await assert.rejects(selectThread(4), /No such thread/);
  });
  test("silent MI commands use waited HTTP receipts and preserve errors", async () => {
    server.removeAllListeners("request");
    const commands: string[] = [];
    server.on("request", (req, res) => {
      assert.strictEqual(req.url, "/api/v1/commands");
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        const request = JSON.parse(body);
        assert.strictEqual(request.wait, true);
        commands.push(request.command);
        res.setHeader("Content-Type", "application/json");
        if (request.command.includes("999")) {
          res.statusCode = 422;
          res.end(JSON.stringify({error: {message: "Unknown global thread 999"}}));
        } else {
          res.end(JSON.stringify({data: {state: "completed", result: {responses: [{status: "running"}]}}}));
        }
      });
    });
    const mi = new MI2("", [], [], undefined);
    mi.sendRaw = () => { throw new Error("Silent command must not use MI stdin"); };
    assert.ok(await mi.next(1));
    assert.ok(await mi.step(1));
    assert.ok(await mi.stepOut(1));
    await mi.sendCommand("send-signal SIGINT --session 1");
    await assert.rejects(Promise.resolve(mi.next(999)), /Unknown global thread 999/);
    assert.deepStrictEqual(commands, ["-exec-next --thread 1", "-exec-step --thread 1", "-exec-finish --thread 1", "-send-signal SIGINT --session 1", "-exec-next --thread 999"]);
  });

});
