import { expect, test } from "bun:test";
import { isTestPath } from "./paths.ts";

const TESTS = [
  "src/app.test.ts",
  "src/app.spec.tsx",
  "lib/util.test.mjs",
  "src/__tests__/app.ts",
  "test_models.py",
  "pkg/models_test.py",
  "tests/conftest.py",
  "server/handler_test.go",
  "crates/core/tests/integration.rs",
  "src/test/java/com/acme/App.java",
  "core/AppTest.java",
  "src/Acme.UnitTests/Fixture.cs",
  "test/test_user.rb",
  "app/src/test/kotlin/AppTests.kt",
  "core/ParserSpec.scala",
  "core/ParserSuite.scala",
  "spec/models/user_spec.rb",
  "lib/user_test.rb",
  "test/test_helper.rb",
  "src/Acme.Tests/OrderServiceTests.cs",
  "src/Acme/OrderServiceTest.cs",
  "tests/Unit/OrderTest.php",
  "Tests/AppTests/LoginTests.swift",
  "test/acme_web/page_controller_test.exs",
  "lib/widget_test.dart",
];

const NOT_TESTS = [
  "src/app.ts",
  "src/contest.ts",
  "src/latest/index.ts",
  "src/testing.py",
  "protest.py",
  "pytest.ini",
  "server/latest.go",
  "crates/core/src/lib.rs",
  "src/main/java/com/acme/Attestation.java",
  "src/main/java/com/acme/TestRunner.java",
  "src/main/java/io/k8s/PodSpec.java",
  "tls/CipherSuite.java",
  "Sources/App/Spec.swift",
  "TEST/data.txt",
  "app/models/user.rb",
  "src/Acme/Order.cs",
  "src/Contest.php",
  "Sources/App/App.swift",
  "lib/acme_web/router.ex",
  "lib/widget.dart",
  "docs/openapi.spec.yaml",
  "api/spec/openapi.yaml",
  "spec/v1/schema.json",
  "src/main/java/org/junit/Test.java",
  "app/src/main/kotlin/ABTest.kt",
  "Sources/App/SpeedTest.swift",
  "src/Feature/LoadTest.php",
  "src/main/kotlin/com/acme/abtest/ExperimentTests.kt",
  "core/src/main/scala/ParserSpec.scala",
  "README.md",
];

test.each(TESTS)("%s is a test", (path) => {
  expect(isTestPath(path)).toBe(true);
});

test.each(NOT_TESTS)("%s is not a test", (path) => {
  expect(isTestPath(path)).toBe(false);
});
