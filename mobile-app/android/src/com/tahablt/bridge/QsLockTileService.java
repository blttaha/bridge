package com.tahablt.bridge;

public class QsLockTileService extends QsMonitorsOnTileService {
    @Override protected String getActionKey() { return "toggle_lock"; }
    @Override protected String getBaseTitle() { return "Kilitle"; }
    @Override protected int getIconRes() { return R.drawable.qs_icon_lock; }
}
