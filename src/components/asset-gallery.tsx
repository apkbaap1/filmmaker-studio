"use client";

import { useActionState, useState } from "react";
import { Badge, Button, Card, ErrorText, Field, Input, Select, Textarea } from "@/components/ui";
import { deleteAssetAction, generateImageAction, uploadAssetAction } from "@/lib/actions/assets";
import type { AssetScope, FormState } from "@/lib/actions/assets";

export type AssetItem = {
  id: string;
  type: "IMAGE" | "VIDEO" | "DIAGRAM" | "AUDIO";
  source: "UPLOADED" | "GENERATED";
  mimeType: string;
  caption: string | null;
  prompt: string | null;
};

function AssetThumb({ projectId, asset }: { projectId: string; asset: AssetItem }) {
  const src = `/api/assets/${asset.id}/file`;

  return (
    <Card className="overflow-hidden">
      <div className="flex aspect-video items-center justify-center bg-surface-2">
        {asset.mimeType.startsWith("image/") ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={asset.caption ?? "Visual reference"} className="h-full w-full object-cover" />
        ) : asset.mimeType.startsWith("video/") ? (
          <video src={src} controls className="h-full w-full object-cover" />
        ) : asset.mimeType.startsWith("audio/") ? (
          // A player rather than a thumbnail: a waveform would need the file
          // decoded and this only needs it heard.
          <audio src={src} controls preload="metadata" className="w-full px-3" />
        ) : (
          <a href={src} target="_blank" rel="noreferrer" className="text-sm text-accent hover:underline">
            Open file
          </a>
        )}
      </div>
      <div className="p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge>{asset.type}</Badge>
          {asset.source === "GENERATED" && <Badge tone="accent">AI generated</Badge>}
        </div>
        {asset.caption && <p className="mt-1.5 text-xs text-muted">{asset.caption}</p>}
        {asset.prompt && <p className="mt-1 text-xs italic text-muted">&ldquo;{asset.prompt}&rdquo;</p>}
        <Button
          variant="danger"
          size="sm"
          className="mt-2"
          onClick={() => {
            if (confirm("Delete this visual?")) deleteAssetAction(projectId, asset.id);
          }}
        >
          Delete
        </Button>
      </div>
    </Card>
  );
}

function UploadForm({ projectId, scope }: { projectId: string; scope: AssetScope }) {
  const [open, setOpen] = useState(false);
  const boundAction = uploadAssetAction.bind(null, projectId, scope);
  const [state, formAction, pending] = useActionState<FormState, FormData>(async (prevState, formData) => {
    const result = await boundAction(prevState, formData);
    if (!result?.error) setOpen(false);
    return result;
  }, undefined);

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        + Upload
      </Button>
    );
  }

  return (
    <Card className="p-4">
      <form action={formAction} className="space-y-3">
        <Field label="File">
          <input
            type="file"
            name="file"
            required
            accept="image/*,video/*,audio/*,application/pdf"
            className="block w-full text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-surface-2 file:px-3 file:py-1.5 file:text-sm file:text-foreground"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <Select name="type" defaultValue="IMAGE">
              <option value="IMAGE">Storyboard / image</option>
              <option value="DIAGRAM">Diagram</option>
              <option value="VIDEO">Video reference</option>
              <option value="AUDIO">Audio — music, dialogue, effects</option>
            </Select>
          </Field>
          <Field label="Caption">
            <Input name="caption" placeholder="What this shows" />
          </Field>
        </div>
        <ErrorText message={state?.error} />
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Uploading…" : "Upload"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function GenerateForm({ projectId, scope }: { projectId: string; scope: AssetScope }) {
  const [open, setOpen] = useState(false);
  const boundAction = generateImageAction.bind(null, projectId, scope);
  const [state, formAction, pending] = useActionState<FormState, FormData>(async (prevState, formData) => {
    const result = await boundAction(prevState, formData);
    if (!result?.error) setOpen(false);
    return result;
  }, undefined);

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        + Generate with AI
      </Button>
    );
  }

  return (
    <Card className="p-4">
      <form action={formAction} className="space-y-3">
        <Field label="Describe the image">
          <Textarea
            name="prompt"
            rows={3}
            required
            placeholder="Wide shot of a rain-soaked alley at night, neon signs reflecting in puddles, cinematic lighting"
          />
        </Field>
        <Field label="Caption (optional)">
          <Input name="caption" placeholder="Storyboard frame 3" />
        </Field>
        <ErrorText message={state?.error} />
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Generating… (can take up to 30s)" : "Generate"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function AssetGallery({
  projectId,
  scope,
  assets,
  imageGenAvailable,
}: {
  projectId: string;
  scope: AssetScope;
  assets: AssetItem[];
  imageGenAvailable: boolean;
}) {
  return (
    <div className="space-y-3">
      {assets.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {assets.map((asset) => (
            <AssetThumb key={asset.id} projectId={projectId} asset={asset} />
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <UploadForm projectId={projectId} scope={scope} />
        <GenerateForm projectId={projectId} scope={scope} />
        {!imageGenAvailable && (
          <span className="text-xs text-muted">
            AI generation needs an OPENAI_API_KEY — see README
          </span>
        )}
      </div>
    </div>
  );
}
