package com.tahablt.bridge;

public class QsShutdownTileService extends QsMonitorsOnTileService {
    @Override protected String getActionKey() { return "shutdown"; }
    @Override protected String getBaseTitle() { return "Kapat"; }
    @Override protected int getIconRes() { return R.drawable.qs_icon_shutdown; }
}
