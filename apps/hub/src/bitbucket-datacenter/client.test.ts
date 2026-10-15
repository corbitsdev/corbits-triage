import { expect, test } from "bun:test";
import { instanceBaseUrl } from "./client.js";

test("an instance URL keeps its context path; credentials, queries, link-local and cloud metadata hosts are refused", () => {
  expect(instanceBaseUrl(" https://git.example/bitbucket/ ")).toBe("https://git.example/bitbucket");
  expect(instanceBaseUrl("http://10.0.0.5:7990")).toBe("http://10.0.0.5:7990");
  for (const refused of ["https://user:pw@git.example", "https://git.example/?a=1", "ftp://git.example", "http://169.254.169.254/latest", "http://[fd00:ec2::254]", "http://[::ffff:a9fe:a9fe]", "http://metadata.google.internal"]) {
    expect(instanceBaseUrl(refused)).toBeUndefined();
  }
});
