// What a run's paid work costs relative to the estimate's calibration model (round 11).
//
// A run is bought on the model it was started on (`config.model_tag`), so every quote after Setup — Gate 1's and
// Gate 2's Continue — scales by that model's price and tokenizer, exactly as Setup's did. `1` for a run without a
// tag (it ran on the default) and until the model list arrives, so a quote is never lower than the charge.
import { useQuery } from "@tanstack/react-query";
import { listModels } from "@/lib/api";
import { costFactor } from "@/lib/model-catalog";

export function useRunCostFactor(runConfig: Record<string, unknown> | undefined): number {
  const { data: catalog } = useQuery({ queryKey: ["models"], queryFn: listModels });
  const tag = runConfig?.model_tag;
  return costFactor(catalog, typeof tag === "string" ? tag : undefined);
}
