import { expect, test } from "bun:test";
import { allPublic, connectTarget } from "./relay.js";

test("the egress proxy serves only CONNECT to a real port on public addresses", () => {
  expect(connectTarget("CONNECT api.github.com:443 HTTP/1.1\r\n")).toEqual({ host: "api.github.com", port: 443 });
  expect(connectTarget("CONNECT [2606:4700::1111]:443 HTTP/1.1\r\n")).toEqual({ host: "2606:4700::1111", port: 443 });
  expect(connectTarget("CONNECT 1.1.1.1:99999 HTTP/1.1\r\n")).toBeNull();
  expect(connectTarget("CONNECT 1.1.1.1:0 HTTP/1.1\r\n")).toBeNull();
  expect(connectTarget("GET http://example.com/ HTTP/1.1\r\n")).toBeNull();

  expect(allPublic([{ address: "140.82.112.6", family: 4 }])).toBe(true);
  for (const address of ["127.0.0.1", "10.1.2.3", "172.17.0.1", "192.168.65.254", "169.254.169.254", "100.64.0.1"]) {
    expect(allPublic([{ address, family: 4 }])).toBe(false);
  }
  for (const address of ["::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    expect(allPublic([{ address, family: 6 }])).toBe(false);
  }
  expect(allPublic([{ address: "140.82.112.6", family: 4 }, { address: "10.0.0.1", family: 4 }])).toBe(false);
  expect(allPublic([])).toBe(false);
});
