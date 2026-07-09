import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { deleteJob, listJobs } from "@/lib/api";

// Terminal statuses; anything else is an in-flight phase (data-driven — we don't enumerate phases).
const TERMINAL = new Set(["complete", "error"]);

export default function JobsPage() {
  const qc = useQueryClient();
  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ["jobs"],
    queryFn: listJobs,
    refetchInterval: 3000,
  });

  async function remove(jobId: string) {
    await deleteJob(jobId);
    qc.invalidateQueries({ queryKey: ["jobs"] });
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <h1 className="text-2xl font-semibold text-ph-ink">Runs</h1>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Records</TableHead>
                <TableHead>Created</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((j) => (
                <TableRow key={j.jobId}>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <Link
                        href={
                          j.status === "complete" || (j.config as { demo?: boolean })?.demo
                            ? `/job/${j.jobId}?results=1`
                            : `/job/${j.jobId}`
                        }
                        className="font-medium text-ph-navy hover:underline"
                      >
                        {j.displayName}
                      </Link>
                      {(j.config as { demo?: boolean })?.demo && (
                        <Badge variant="outline" className="border-ph-navy/30 text-ph-navy">
                          Demo
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={j.status === "complete" ? "secondary" : j.status === "error" ? "destructive" : "outline"}>
                      {TERMINAL.has(j.status) ? j.status : j.phase}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{j.nRecords || "—"}</TableCell>
                  <TableCell className="text-sm text-neutral-500">
                    {new Date(j.createdAt * 1000).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" onClick={() => remove(j.jobId)} aria-label="Delete">
                      <Trash2 className="h-4 w-4 text-neutral-400" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!jobs.length && !isLoading && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-neutral-400">
                    No runs yet. <Link href="/new" className="text-ph-navy hover:underline">Start one →</Link>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
