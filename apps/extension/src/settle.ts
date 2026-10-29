import { errorText } from "@corbits/common";

export async function settle(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch (cause) {
    console.warn(errorText(cause));
  }
}
