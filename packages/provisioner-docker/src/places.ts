import type { PlaceGuide } from "@corbits/triage-contracts";

export const DOCKER_PLACE = {
  id: "docker",
  label: "Docker on this machine",
  why: "The simplest choice when the Triage server can run Docker: each review gets a container of its own.",
  env: [],
  guide: "docker.md",
} satisfies PlaceGuide;

export const DOCKER_REMOTE_PLACE = {
  id: "docker-remote",
  label: "Docker on another machine (TLS)",
  why: "For a Triage server that can't run Docker, such as one on Railway: reviews run in containers on a server you control.",
  env: ["DOCKER_HOST=tcp://docker.example.com:2376", "DOCKER_TLS_CA=<base64 of ca.pem>", "DOCKER_TLS_CERT=<base64 of cert.pem>", "DOCKER_TLS_KEY=<base64 of key.pem>"],
  guide: "docker-remote.md",
} satisfies PlaceGuide;
