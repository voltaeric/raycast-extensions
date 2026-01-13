import fse from "fs-extra";
import type { RequestInit } from "node-fetch";
import fetch, { FetchError } from "node-fetch";
import https from "node:https";

import { join } from "node:path";
import { platform } from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

import { Toast, getPreferenceValues, open, showHUD, showInFinder, showToast } from "@raycast/api";
import { runAppleScript } from "@raycast/utils";

const execAsync = promisify(exec);

import type { BookEntry } from "@/types";
import type { LibgenPreferences } from "@/types";

import { parseLowerCaseArray } from "./common";
import { languages } from "./constants";
import { showActionToast, showFailureToast } from "./toast";

const fetchImageArrayBuffer = async (url: string, signal?: AbortSignal): Promise<ArrayBuffer> => {
  const requestInit: RequestInit = {
    method: "GET",
    signal: signal,
  };
  const { allowIgnoreHTTPSErrors } = getPreferenceValues<LibgenPreferences>();
  if (allowIgnoreHTTPSErrors) {
    requestInit.agent = new https.Agent({
      rejectUnauthorized: false,
    });
  }
  const res = await fetch(url, requestInit);
  const buffer = await res.arrayBuffer();
  return buffer;
};

export const sortBooksByPreferredLanguages = (books: BookEntry[], preferredLanguages: string) => {
  // parse the languages to a list in lower case
  const preferredLanguageList = parseLowerCaseArray(preferredLanguages);

  // keep only accept languages that are in the list of supported languages
  const filteredPreferredLanguageList = preferredLanguageList.filter((pl) =>
    languages.map((l) => l.name.toLowerCase()).includes(pl),
  );

  // generate a weight table based on the order of languages
  const languageWeights: { [language: string]: number } = {};
  filteredPreferredLanguageList.forEach((pl, i) => {
    languageWeights[pl] = filteredPreferredLanguageList.length - i;
  });

  // sort books based on the language weight
  books.sort((a, b) => {
    // some books contains more than one languages in the attribute
    const languagesA = parseLowerCaseArray(a.language);
    // add up weights for all languages
    const weightA = languagesA.map((l) => (l in languageWeights ? languageWeights[l] : 0)).reduce((p, c) => p + c, 0);

    const languagesB = parseLowerCaseArray(b.language);
    const weightB = languagesB.map((l) => (l in languageWeights ? languageWeights[l] : 0)).reduce((p, c) => p + c, 0);

    return weightB - weightA;
  });

  return books;
};

export const sortBooksByPreferredFileFormats = (books: BookEntry[], preferredFormats: string) => {
  // parse the formats to a list in lower case
  const preferredFormatList = parseLowerCaseArray(preferredFormats);
  // generate a weight table based on the order of formats
  const formatWeights: { [format: string]: number } = {};
  preferredFormatList.forEach((pf, i) => {
    formatWeights[pf] = preferredFormatList.length - i;
  });

  // sort books based on the format weight
  books.sort((a, b) => {
    // https://stackoverflow.com/questions/20864893/replace-all-non-alphanumeric-characters-new-lines-and-multiple-white-space-wit
    // clean up the file format string
    const extensionA = a.extension.replace(/[\W_]+/g, "");
    const weightA = extensionA in formatWeights ? formatWeights[extensionA] : 0;

    const extensionB = b.extension.replace(/[\W_]+/g, "");
    const weightB = extensionB in formatWeights ? formatWeights[extensionB] : 0;

    return weightB - weightA;
  });

  return books;
};

export const fileNameFromBookEntry = ({ title, author, year }: BookEntry) => {
  return `${author} - ${title}${year && " (" + year + ")"}`.replace(/\//g, ""); // remove slashes
};

export const fileNameWithExtensionFromBookEntry = (book: BookEntry) => {
  const fileName = fileNameFromBookEntry(book);
  return fileName + "." + book.extension.toLowerCase();
};

export function buildFileName(path: string, name: string, extension: string) {
  const baseName = `${name}.${extension}`;
  const filePath = join(path, baseName);
  const directoryExists = fse.existsSync(filePath);

  if (!directoryExists) {
    return baseName;
  } else {
    let index = 2;
    while (true) {
      const newName = `${name}-${index}.${extension}`;
      const newPath = join(path, newName);
      if (!fse.existsSync(newPath)) {
        return newName;
      }
      index++;
    }
  }
}

export async function downloadBookToDefaultDirectory(url = "", book: BookEntry) {
  const { downloadPath } = getPreferenceValues<LibgenPreferences>();
  const name = fileNameFromBookEntry(book);
  const extension = book.extension.toLowerCase();

  console.log("Download", downloadPath, name, extension);

  const toast = await showActionToast({
    title: "Downloading...",
    cancelable: true,
  });
  try {
    const fileName = buildFileName(downloadPath, name, extension);
    const filePath = `${downloadPath}/${fileName}`;
    const arrayBuffer = await fetchImageArrayBuffer(url, toast.signal);
    console.log(url, arrayBuffer.byteLength / 1024, "KB");

    fse.writeFileSync(filePath, Buffer.from(arrayBuffer));

    const options: Toast.Options = {
      style: Toast.Style.Success,
      title: "Success!",
      message: `Saved to ${downloadPath}`,
      primaryAction: {
        title: "Open Book",
        onAction: (toast) => {
          open(filePath);
          toast.hide();
        },
      },
      secondaryAction: {
        title: "Show in finder",
        onAction: (toast) => {
          showInFinder(filePath);
          toast.hide();
        },
      },
    };
    await showToast(options);
  } catch (err) {
    if (err instanceof FetchError && err.code === "CERT_HAS_EXPIRED") {
      await showFailureToast(
        "Download Failed",
        new Error(
          "The certificate has expired. Try with a different download gateway or enable 'Ignore HTTPS Errors' in your settings.",
        ),
      );
      return;
    }
    await showFailureToast("Download Failed", err as Error);
  }
}

async function chooseDownloadFolder(): Promise<string | null> {
  const currentPlatform = platform();
  if (currentPlatform === "darwin") {
    try {
      return (
        await runAppleScript(`
        set outputFolder to choose folder with prompt "Please select an output folder:"
        return POSIX path of outputFolder
      `)
      ).trim();
    } catch (e) {
      return null;
    }
  } else if (currentPlatform === "win32") {
    try {
      const psCommand = `
        Add-Type -AssemblyName System.Windows.Forms
        $f = New-Object System.Windows.Forms.FolderBrowserDialog
        $f.Description = "Select Download Folder"
        $f.ShowNewFolderButton = $true
        if ($f.ShowDialog() -eq "OK") { Write-Host $f.SelectedPath -NoNewline }
      `;
      const { stdout } = await execAsync(`powershell -NoProfile -Command "${psCommand.replace(/"/g, '\\"')}"`);
      return stdout.trim() || null;
    } catch (e) {
      console.error("Folder picker error:", e);
      return null;
    }
  }
  return null;
}

export async function downloadBookToLocation(url = "", book: BookEntry) {
  const name = fileNameFromBookEntry(book);
  const extension = book.extension.toLowerCase();

  // 1. Pick Folder
  const outputFolder = await chooseDownloadFolder();
  if (!outputFolder) {
    return; // User cancelled
  }

  // 2. Download
  const toast = await showActionToast({
    title: "Downloading...",
    cancelable: true,
  });

  try {
    const fileName = buildFileName(outputFolder, name, extension);
    const filePath = join(outputFolder, fileName);

    const arrayBuffer = await fetchImageArrayBuffer(url, toast.signal);
    fse.writeFileSync(filePath, Buffer.from(arrayBuffer));

    const options: Toast.Options = {
      style: Toast.Style.Success,
      title: "Success!",
      message: `Saved to ${fileName}`,
      primaryAction: {
        title: "Open Book",
        onAction: (toast) => {
          open(filePath);
          toast.hide();
        },
      },
      secondaryAction: {
        title: "Show in finder",
        onAction: (toast) => {
          showInFinder(filePath);
          toast.hide();
        },
      },
    };
    await showToast(options);
  } catch (err) {
    if (err instanceof FetchError && err.code === "CERT_HAS_EXPIRED") {
      await showFailureToast(
        "Download Failed",
        new Error(
          "The certificate has expired. Try with a different download gateway or enable 'Ignore HTTPS Errors' in your settings.",
        ),
      );
      return;
    }
    await showFailureToast("Download Failed", err as Error);
  }
}
