import React, { Fragment } from "react";

import { blobToStr } from '../../../../util';
import { md5 } from '../../../../util';
import { removeEmptyArrayItems } from '../../../../util';
import { setMessageAnchorId } from '../../message';
import { settings } from '../../../../settings';
import { DiscSelectionEditor } from '../../../screens/selectdisc'
import { FetchAppData } from '../../../../app';
import { Resources } from '../../../../resources';
import { UrlUtil } from '../../../../util';
import { WebrcadeApp } from '..';
import * as LOG  from '../../../../log';
import { TEXT_IDS } from '../../../../resources';

export class WebrcadeRetroApp extends WebrcadeApp {
  emulator = null;

  MODE_DISC_SELECT = 'discSelectionMode';

  constructor() {
    super();

    this.state.mode = null;
  }

  createEmulator(app, isDebug) {
    throw "createEmulator is not implemented.";
  }

  getBiosMap() {
    return null;
  }

  getAlternateBiosMap() {
    return null;
  }

  getBiosUrls() {
    return null;
  }

  async fetchBios(bios) {
    let biosBuffers = {};

    const BIOS_MAP = this.getBiosMap();
    const ALT_BIOS_MAP = this.getAlternateBiosMap();

    for (let i = 0; i < bios.length; i++) {
      const biosUrl = bios[i];
      if (biosUrl.trim().length === 0) {
        continue;
      }

      const fad = new FetchAppData(biosUrl);
      const res = await fad.fetch();
      const blob = await res.blob();
      const blobStr = await blobToStr(blob);
      const md5Hash = md5(blobStr);
      let name = BIOS_MAP[md5Hash];
      if (ALT_BIOS_MAP && !name) {
        name = ALT_BIOS_MAP[md5Hash];
      }
      if (name) {
        biosBuffers[name] = new Uint8Array(await blob.arrayBuffer());
      }
    }

    let haveBuffers = false;
    if (ALT_BIOS_MAP) {
      for (let p in ALT_BIOS_MAP) {
        const f = ALT_BIOS_MAP[p];
        for (let n in biosBuffers) {
          if (f === n) {
            const buff = biosBuffers[n];
            biosBuffers = {};
            biosBuffers[n] = buff;
            haveBuffers = true;
            break;
          }
        }
      }
    }

    if (!haveBuffers) {
      for (let p in BIOS_MAP) {
        const f = BIOS_MAP[p];
        let found = false;
        for (let n in biosBuffers) {
          if (f === n) {
            found = true;
            break;
          }
        }
        if (!found) throw new Error(`Unable to find BIOS file: ${f}`);
      }
    }

    console.log(biosBuffers);

    return biosBuffers;
  }

  // TODO: Move this to common
  async fetchResponseBuffer(response) {
    //let checksum = 0;

    let length = response.headers.get('Content-Length');
    if (length) {
      length = parseInt(length);
      let array = new Uint8Array(length);
      let at = 0;
      let reader = response.body.getReader();
      for (;;) {
        let { done, value } = await reader.read();
        if (done) {
          break;
        }
        array.set(value, at);
        at += value.length;

        // for (let i = 0; i < value.length; i++) {
        //   checksum += value[i];
        // }

        const progress = ((at / length).toFixed(2) * 100).toFixed(0);
        this.setState({ loadingPercent: progress | 0 });
      }
      try {
        // console.log("##### " + checksum)
        // alert(checksum)
        return array;
      } finally {
        array = null;
      }
    } else {
      const blob = await response.blob();
      return new Uint8Array(await new Response(blob).arrayBuffer());
    }
  }

  getExtension(url, fad, res) {
    let filename = fad.getFilename(res);
    if (!filename) {
      filename = UrlUtil.getFileName(url);
    }
    if (filename) {
      const comps = filename.split('.');
      if (comps.length > 1) {
        return comps[comps.length - 1].toLowerCase();
      }
    }
    return null;
  }

  start(discIndex) {
    setMessageAnchorId('canvas');

    const { bios, discs, emulator, uid, ModeEnum } = this;

    this.setState({ mode: ModeEnum.LOADING });

    try {
      let biosBuffers = null;
      let frontend = null;
      let extension = null;

      const discUrl = discs[discIndex];
      const fad = new FetchAppData(discUrl);

      // Load Emscripten and ROM binaries
      settings
        .load()
        .then(() => emulator.loadEmscriptenModule(this.canvas))
        .then(() => this.fetchBios(bios))
        .then((b) => {
          biosBuffers = b;
        })
        // .then(() => settings.setBilinearFilterEnabled(true))
        // .then(() => settings.setVsyncEnabled(false))
        .then(() => fad.fetch())
        .then((response) => {
          extension = this.getExtension(discUrl, fad, response);
          return response;
        })
        .then((response) => this.fetchResponseBuffer(response))
        .then((bytes) => {
          emulator.setRoms(uid, frontend, biosBuffers, bytes, extension);
          return bytes;
        })
        .then(() =>
          this.setState({
            mode: ModeEnum.LOADED,
            loadingMessage: 'Loading',
          }),
        )
        .catch((msg) => {
          LOG.error(msg);
          this.exit(
            msg ? msg : Resources.getText(TEXT_IDS.ERROR_RETRIEVING_GAME),
          );
        });
    } catch (e) {
      this.exit(e);
    }
  }

  componentDidMount() {
    super.componentDidMount();

    const { appProps } = this;

    // Create the emulator
    if (this.emulator === null) {
      try {
        this.emulator = this.createEmulator(this, this.isDebug());

        // Get the uid
        this.uid = appProps.uid;
        if (!this.uid)
          throw new Error('A unique identifier was not found for the game.');

        // Get the discs location that was specified
        this.discs = appProps.discs;
        if (this.discs) this.discs = removeEmptyArrayItems(this.discs);
        if (!this.discs || this.discs.length === 0)
          throw new Error('A disc was not specified.');

        this.bios = this.getBiosUrls(appProps);
        if (this.bios && !Array.isArray(this.bios)) {
          this.bios = [this.bios];
        }

        if (this.bios) this.bios = removeEmptyArrayItems(this.bios);
        if (!this.bios || this.bios.length === 0)
          throw new Error('BIOS file(s) were not specified.');

        if (this.discs.length > 1) {
          this.setState({ mode: this.MODE_DISC_SELECT });
        } else {
          this.start(0);
        }
      } catch (msg) {
        LOG.error(msg);
        this.exit(
          msg ? msg : Resources.getText(TEXT_IDS.ERROR_RETRIEVING_GAME),
        );
      }
    }
  }

  async onPreExit() {
    try {
      await super.onPreExit();
      if (!this.isExitFromPause()) {
        await this.emulator.saveState();
      }
    } catch (e) {
      LOG.error(e);
    }
  }

  componentDidUpdate() {
    const { mode } = this.state;
    const { ModeEnum, emulator, canvas } = this;

    if (mode === ModeEnum.LOADED) {
      window.focus();
      // Start the emulator
      emulator.start(canvas);
    }
  }

  renderPauseScreen() {
    throw "renderPauseScreen not implemented";
  }

  renderCanvas() {
    return (
      <canvas
        ref={(canvas) => {
          this.canvas = canvas;
        }}
        id="canvas"
      ></canvas>
    );
  }

  render() {
    const { errorMessage, loadingMessage, mode } = this.state;
    const { ModeEnum, MODE_DISC_SELECT } = this;

    return (
      <Fragment>
        {super.render()}
        {mode === MODE_DISC_SELECT && this.discs ? (
          <DiscSelectionEditor app={this} />
        ) : null}
        {mode === ModeEnum.LOADING || (loadingMessage && !errorMessage)
          ? this.renderLoading()
          : null}
        {mode === ModeEnum.PAUSE ? this.renderPauseScreen() : null}
        {this.renderCanvas()}
      </Fragment>
    );
  }
}

export default App;
